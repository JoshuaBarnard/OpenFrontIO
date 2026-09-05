import { Execution, Game, Player, PlayerID, UnitType } from "../game/Game";
import { areDiplomaticallyFriendly } from "../game/Vassal";
import { PseudoRandom } from "../PseudoRandom";
import { simpleHash } from "../Util";
import { ConstructionExecution } from "./ConstructionExecution";
import { NationEmojiBehavior } from "./nation/NationEmojiBehavior";
import { NationStructureBehavior } from "./nation/NationStructureBehavior";
import { randTerritoryTileArray } from "./nation/NationUtils";
import { AiAttackBehavior } from "./utils/AiAttackBehavior";

/**
 * Nation-grade AI for a vassal.
 *
 * A normal NationExecution owns its diplomacy and may create/break alliances.
 * Vassals deliberately do not: VassalAllianceExecution mirrors the founder's
 * diplomacy instead. This controller therefore combines the real nation
 * structure builder with autonomous expansion/combat and founder defence.
 */
export class VassalNationExecution implements Execution {
  private active = true;
  private mg: Game;
  private random: PseudoRandom;
  private attackBehavior: AiAttackBehavior | null = null;
  private emojiBehavior: NationEmojiBehavior | null = null;
  private structureBehavior: NationStructureBehavior | null = null;
  private neighborsTerraNullius = true;
  private lastFounderAidTick = -Infinity;

  private attackRate: number;
  private attackTick: number;
  private triggerRatio: number;
  private reserveRatio: number;
  private expandRatio: number;

  constructor(
    private vassal: Player,
    private founderID: PlayerID,
  ) {
    this.random = new PseudoRandom(simpleHash(vassal.id()));
    this.attackRate = this.random.nextInt(40, 80);
    this.attackTick = this.random.nextInt(0, this.attackRate);
    this.triggerRatio = this.random.nextInt(50, 60) / 100;
    this.reserveRatio = this.random.nextInt(30, 40) / 100;
    this.expandRatio = this.random.nextInt(10, 20) / 100;
  }

  init(mg: Game): void {
    this.mg = mg;
  }

  tick(ticks: number): void {
    if (!this.vassal.isAlive()) {
      this.active = false;
      return;
    }

    if (
      this.attackBehavior === null ||
      this.emojiBehavior === null ||
      this.structureBehavior === null
    ) {
      // AiAttackBehavior treats Nation players specially and requires a
      // NationEmojiBehavior before it can calculate/send attacks against other
      // players. Normal NationExecution wires this dependency in; vassals must
      // do the same even though their alliance behavior is intentionally owned
      // by VassalAllianceExecution instead.
      this.emojiBehavior = new NationEmojiBehavior(
        this.random,
        this.mg,
        this.vassal,
      );
      this.attackBehavior = new AiAttackBehavior(
        this.random,
        this.mg,
        this.vassal,
        this.triggerRatio,
        this.reserveRatio,
        this.expandRatio,
        undefined,
        this.emojiBehavior,
      );
      this.structureBehavior = new NationStructureBehavior(
        this.random,
        this.mg,
        this.vassal,
      );

      // Newly-founded vassals begin with one city in a compact estate. Normal
      // Nation ratios round 0.75 structures-per-city down to zero, while normal
      // city spacing can make a second city impossible until the realm expands.
      // Bootstrap one useful economic structure immediately so a funded vassal
      // cannot get stuck forever as a one-city nation.
      this.handleVassalStructures();

      // Give the new vassal one immediate useful military decision too.
      // Founder defence wins over expansion if the founder is already attacked.
      if (!this.defendFounder()) {
        this.attackBehavior.sendAttack(this.mg.terraNullius());
      }
      return;
    }

    if (ticks % this.attackRate !== this.attackTick) {
      // Match NationExecution's spending cadence: structure AI gets two extra
      // opportunities between combat decisions so accumulated gold is used.
      const offset = ticks % this.attackRate;
      const oneThird =
        (this.attackTick + Math.floor(this.attackRate / 3)) % this.attackRate;
      const twoThirds =
        (this.attackTick + Math.floor((this.attackRate * 2) / 3)) %
        this.attackRate;
      if (offset === oneThird || offset === twoThirds) {
        this.handleVassalStructures();
      }
      return;
    }

    // Vassals use the real Nation structure planner, so after the compact-estate
    // bootstrap they build and upgrade Cities, Factories, Ports, SAMs and
    // Missile Silos using the same strategy as ordinary nations.
    this.handleVassalStructures();

    // An attack on the founder takes priority over unrelated aggression.
    if (this.defendFounder()) return;

    this.maybeAttack();
  }

  /**
   * Prevent the initial radius-20 estate from deadlocking the standard nation
   * structure ratios. A one-city vassal gets one Factory and, when possible,
   * one Port before falling back to the normal NationStructureBehavior.
   */
  private handleVassalStructures(): boolean {
    if (this.bootstrapCoreStructure()) return true;
    return this.structureBehavior?.handleStructures() ?? false;
  }

  private bootstrapCoreStructure(): boolean {
    // If the capital has been destroyed, let normal Nation AI prioritize
    // rebuilding a City rather than trying to create supporting structures.
    if (this.vassal.units(UnitType.City).length === 0) return false;

    const bootstrapOrder = [UnitType.Factory, UnitType.Port] as const;
    for (const type of bootstrapOrder) {
      if (this.mg.config().isUnitDisabled(type)) continue;
      // units() includes under-construction structures, preventing duplicate
      // bootstrap queues while the first building is still being constructed.
      if (this.vassal.units(type).length > 0) continue;

      const cost = this.mg.unitInfo(type).cost(this.mg, this.vassal);
      if (this.vassal.gold() < cost) continue;

      const tile = this.findBootstrapStructureTile(type);
      if (tile === null) continue;

      this.mg.addExecution(new ConstructionExecution(this.vassal, type, tile));
      return true;
    }

    return false;
  }

  private findBootstrapStructureTile(type: UnitType): number | null {
    if (type === UnitType.Port) {
      // Ports need shore territory. Sample a larger set than normal because a
      // fresh vassal estate is compact and can have very few legal shore tiles.
      const borderTiles = this.random
        .shuffleArray(Array.from(this.vassal.borderTiles()))
        .slice(0, 250);
      for (const tile of borderTiles) {
        if (!this.mg.isShore(tile)) continue;
        const buildTile = this.vassal.canBuild(type, tile);
        if (buildTile !== false) return buildTile;
      }
      return null;
    }

    // Normal NationStructureBehavior samples 25 tiles. A compact estate has a
    // much higher chance of those landing near the capital/border, so use a
    // broader sample for the one-time Factory bootstrap.
    for (const tile of randTerritoryTileArray(
      this.random,
      this.mg,
      this.vassal,
      120,
    )) {
      const buildTile = this.vassal.canBuild(type, tile);
      if (buildTile !== false) return buildTile;
    }
    return null;
  }

  private founder(): Player | null {
    if (!this.mg.hasPlayer(this.founderID)) return null;
    const founder = this.mg.player(this.founderID);
    return founder.isAlive() ? founder : null;
  }

  private defendFounder(): boolean {
    if (this.attackBehavior === null) return false;

    const founder = this.founder();
    if (founder === null) return false;

    let largestAttackTroops = 0;
    let totalIncomingTroops = 0;
    let attacker: Player | null = null;

    for (const attack of founder.incomingAttacks()) {
      const candidate = attack.attacker();
      if (candidate === this.vassal || candidate === founder) continue;

      totalIncomingTroops += attack.troops();
      if (attack.troops() > largestAttackTroops) {
        largestAttackTroops = attack.troops();
        attacker = candidate;
      }
    }

    if (attacker === null) return false;

    // If diplomacy changed this tick, remove a stale mirrored alliance without
    // marking the vassal as a traitor before retaliating for its founder.
    const staleAlliance = this.vassal.allianceWith(attacker);
    if (staleAlliance !== null && !founder.isAlliedWith(attacker)) {
      staleAlliance.expire();
    }

    if (!areDiplomaticallyFriendly(this.mg, this.vassal, attacker)) {
      if (this.attackBehavior.sendAttack(attacker, true)) return true;
    }

    this.sendDefensiveTroopAid(founder, totalIncomingTroops);
    return true;
  }

  private sendDefensiveTroopAid(
    founder: Player,
    founderIncomingTroops: number,
  ): boolean {
    if (!this.vassal.isFriendly(founder)) return false;
    if (
      this.mg.ticks() - this.lastFounderAidTick <
      this.mg.config().donateCooldown()
    ) {
      return false;
    }

    const maxTroops = this.mg.config().maxTroops(this.vassal);
    const baselineReserve = maxTroops * this.reserveRatio;

    // Do not weaken the vassal below the strongest hostile player that shares
    // an actual land border with it.
    let strongestBorderEnemy = 0;
    for (const neighbor of this.vassal.nearby()) {
      if (!neighbor.isPlayer()) continue;
      if (areDiplomaticallyFriendly(this.mg, this.vassal, neighbor)) continue;
      if (!this.vassal.sharesBorderWith(neighbor)) continue;
      strongestBorderEnemy = Math.max(
        strongestBorderEnemy,
        neighbor.troops(),
      );
    }

    const incomingToVassal = this.vassal
      .incomingAttacks()
      .filter(
        (attack) =>
          !areDiplomaticallyFriendly(
            this.mg,
            this.vassal,
            attack.attacker(),
          ),
      )
      .reduce((sum, attack) => sum + attack.troops(), 0);

    const defensiveReserve = Math.max(
      baselineReserve,
      strongestBorderEnemy,
      incomingToVassal,
    );
    const spareTroops = Math.floor(this.vassal.troops() - defensiveReserve);
    const founderCapacity = Math.max(
      0,
      this.mg.config().maxTroops(founder) - founder.troops(),
    );
    const troopsToSend = Math.min(
      spareTroops,
      Math.ceil(founderIncomingTroops),
      founderCapacity,
    );

    if (troopsToSend < 1) return false;

    // This is a vassal obligation rather than an optional manual donation, so
    // it intentionally bypasses the lobby's donate-troops toggle. The normal
    // low-level transfer still emits the standard donation update.
    if (!this.vassal.donateTroops(founder, troopsToSend)) return false;

    this.lastFounderAidTick = this.mg.ticks();
    return true;
  }

  private maybeAttack(): void {
    if (this.attackBehavior === null) return;

    const traitor = this.attackBehavior.getNeighborTraitorToAttack();
    if (traitor !== null && traitor.id() !== this.founderID) {
      if (
        !areDiplomaticallyFriendly(this.mg, this.vassal, traitor) &&
        this.random.chance(3)
      ) {
        if (this.attackBehavior.sendAttack(traitor)) return;
      }
    }

    // Unclaimed land is the safest expansion and remains the first choice.
    if (this.neighborsTerraNullius) {
      if (this.vassal.nearby().some((neighbor) => !neighbor.isPlayer())) {
        if (this.attackBehavior.sendAttack(this.mg.terraNullius())) return;
      } else {
        this.neighborsTerraNullius = false;
      }
    }

    // Once neutral expansion cannot be launched, actively seek territory from
    // realms that are not friendly with the owner. Shared-border enemies are
    // tried first, then other hostile players; sendAttack can use transport
    // ships for the latter when a route exists. Reserve/strength checks remain
    // inside AiAttackBehavior, so this does not make vassals suicidal.
    if (this.attackOwnerHostileRealm()) return;

    this.attackBehavior.attackRandomTarget();
  }

  private attackOwnerHostileRealm(): boolean {
    if (this.attackBehavior === null) return false;

    const hostile = this.mg.players().filter(
      (candidate) =>
        candidate !== this.vassal &&
        candidate.id() !== this.founderID &&
        !areDiplomaticallyFriendly(this.mg, this.vassal, candidate),
    );
    if (hostile.length === 0) return false;

    const bordering = hostile.filter((candidate) =>
      this.vassal.sharesBorderWith(candidate),
    );
    const borderingSet = new Set(bordering);
    const distant = hostile.filter((candidate) => !borderingSet.has(candidate));
    const candidates = [
      ...this.random.shuffleArray(bordering),
      ...this.random.shuffleArray(distant),
    ];

    for (const candidate of candidates) {
      if (this.attackBehavior.sendAttack(candidate)) return true;
    }
    return false;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
