import { Execution, Game, Player, PlayerID, UnitType } from "../game/Game";
import { areDiplomaticallyFriendly } from "../game/Vassal";
import { PseudoRandom } from "../PseudoRandom";
import { simpleHash } from "../Util";
import { ConstructionExecution } from "./ConstructionExecution";
import { NationEmojiBehavior } from "./nation/NationEmojiBehavior";
import { NationStructureBehavior } from "./nation/NationStructureBehavior";
import { randTerritoryTileArray } from "./nation/NationUtils";
import { closestTwoTiles } from "./Util";
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

    // A direct attack on the vassal itself is the most immediate local threat.
    // Even when the vassal cannot counterattack yet, treat the decision as
    // handled so it does not spend troops on an unrelated distant war instead.
    if (this.defendSelf()) return;

    // Unclaimed land is safe growth. It can improve the vassal's economy and
    // troop ceiling without starting a remote war, so keep it ahead of
    // proactive attacks when it is locally available.
    if (this.neighborsTerraNullius) {
      if (this.vassal.nearby().some((neighbor) => !neighbor.isPlayer())) {
        if (this.attackBehavior.sendAttack(this.mg.terraNullius())) return;
      } else {
        this.neighborsTerraNullius = false;
      }
    }

    // Hostile-player wars are proximity driven. The method returns true both
    // when an attack was launched and when a nearby threat exists but the
    // vassal is intentionally building troops for it.
    this.attackOwnerHostileRealm();
  }

  private defendSelf(): boolean {
    if (this.attackBehavior === null) return false;

    let attacker: Player | null = null;
    let largestAttack = 0;
    for (const attack of this.vassal.incomingAttacks()) {
      const candidate = attack.attacker();
      if (areDiplomaticallyFriendly(this.mg, this.vassal, candidate)) continue;
      if (attack.troops() <= largestAttack) continue;
      largestAttack = attack.troops();
      attacker = candidate;
    }

    if (attacker === null) return false;

    this.attackBehavior.sendAttack(attacker, true);
    return true;
  }

  /**
   * Pick a strategic war target by geography rather than global weakness.
   *
   * 1. Land-border and `nearby()` hostiles are the local theatre. The vassal
   *    will only fight inside that theatre while any such enemy exists.
   * 2. If local enemies are currently too strong, it keeps its troops and lets
   *    normal growth/structure AI raise its strength instead of boating across
   *    the world to find an easier victim.
   * 3. With no local enemies, only a small distance band around the nearest
   *    hostile realms is considered. This keeps overseas wars regional.
   */
  private attackOwnerHostileRealm(): boolean {
    if (this.attackBehavior === null) return false;

    const hostile = this.mg.players().filter(
      (candidate) =>
        candidate.isAlive() &&
        candidate !== this.vassal &&
        candidate.id() !== this.founderID &&
        !areDiplomaticallyFriendly(this.mg, this.vassal, candidate),
    );
    if (hostile.length === 0) return false;

    const nearbyPlayers = new Set(
      this.vassal
        .nearby()
        .filter(
          (candidate): candidate is Player =>
            candidate.isPlayer() &&
            candidate.isAlive() &&
            candidate.id() !== this.founderID &&
            !areDiplomaticallyFriendly(this.mg, this.vassal, candidate),
        ),
    );

    const ranked = hostile
      .map((player) => {
        const bordering = this.vassal.sharesBorderWith(player);
        return {
          player,
          bordering,
          local: bordering || nearbyPlayers.has(player),
          distance: this.distanceToRealm(player),
        };
      })
      .filter((entry) => Number.isFinite(entry.distance))
      .sort((a, b) => {
        if (a.bordering !== b.bordering) return a.bordering ? -1 : 1;
        if (a.distance !== b.distance) return a.distance - b.distance;
        // At the same distance, take the more achievable local expansion first.
        return a.player.troops() - b.player.troops();
      });

    if (ranked.length === 0) return true;

    const local = ranked.filter((entry) => entry.local);
    if (local.length > 0) {
      for (const entry of local) {
        if (!this.isStrategicallyReady(entry.player, true)) continue;
        if (this.attackBehavior.sendAttack(entry.player, true)) return true;
      }

      // A local hostile exists but is not yet a sensible attack. Hold the
      // strategic reserve and keep developing until the balance improves.
      return true;
    }

    const nearestDistance = ranked[0].distance;
    const distanceBand = Math.max(40, Math.floor(nearestDistance * 0.35));
    const regional = ranked
      .filter((entry) => entry.distance <= nearestDistance + distanceBand)
      .slice(0, 4);

    for (const entry of regional) {
      // Remote wars should be opportunistic, not desperate. Unlike a local
      // threat, a distant opponent that is too strong is simply not worth a
      // transport expedition yet.
      if (!this.isStrategicallyReady(entry.player, false)) continue;
      if (this.attackBehavior.sendAttack(entry.player, true)) return true;
    }

    // There are hostile realms, but none in the nearest regional band are a
    // sensible/reachable target right now. Wait rather than falling back to the
    // old random-global targeting and crossing the map for a weak player.
    return true;
  }

  private distanceToRealm(target: Player): number {
    if (this.vassal.sharesBorderWith(target)) return 0;

    const closest = closestTwoTiles(
      this.mg,
      this.vassal.borderTiles(),
      target.borderTiles(),
    );
    if (closest === null) return Number.POSITIVE_INFINITY;
    return this.mg.manhattanDist(closest.x, closest.y);
  }

  /**
   * Decide whether a proactive war is worth committing troops to yet.
   *
   * Local threats are allowed to force the issue once the vassal is near its
   * troop ceiling, even when the neighbour is stronger. Distant targets do not
   * get that exception: if the expeditionary force would be obviously weak,
   * the vassal keeps building instead.
   */
  private isStrategicallyReady(target: Player, local: boolean): boolean {
    const maxTroops = Math.max(1, this.mg.config().maxTroops(this.vassal));
    const ownTroops = this.vassal.troops();
    if (ownTroops < maxTroops * this.triggerRatio) return false;

    const bordering = this.vassal.sharesBorderWith(target);
    const reserveTroops = maxTroops * this.reserveRatio;
    const availableForce = bordering
      ? Math.max(0, ownTroops - reserveTroops)
      : ownTroops / 5;
    const maxAvailableForce = bordering
      ? Math.max(1, maxTroops - reserveTroops)
      : Math.max(1, maxTroops / 5);

    // Land wars can commit most troops above the reserve. Boat attacks only
    // carry about one fifth of current troops, so require a smaller fraction of
    // the target while still refusing wildly underpowered remote expeditions.
    const desiredTargetFraction = bordering ? 0.5 : 0.25;
    if (availableForce >= target.troops() * desiredTargetFraction) return true;

    if (!local) return false;

    // A powerful neighbour must not send the vassal searching for a weaker
    // opponent elsewhere. Once the vassal has filled roughly its whole troop
    // pool, let normal AiAttackBehavior make the final reserve/attack-size call.
    return (
      ownTroops >= maxTroops * 0.9 &&
      availableForce >= maxAvailableForce * 0.85
    );
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
