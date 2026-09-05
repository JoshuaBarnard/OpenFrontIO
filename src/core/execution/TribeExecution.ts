import {
  Execution,
  Game,
  Player,
  PlayerID,
  Structures,
} from "../game/Game";
import { PseudoRandom } from "../PseudoRandom";
import { simpleHash } from "../Util";
import { AllianceExtensionExecution } from "./alliance/AllianceExtensionExecution";
import { DeleteUnitExecution } from "./DeleteUnitExecution";
import { AiAttackBehavior } from "./utils/AiAttackBehavior";

export class TribeExecution implements Execution {
  private active = true;
  private random: PseudoRandom;
  private mg: Game;
  private neighborsTerraNullius = true;
  private lastProtectedPlayerAidTick = -Infinity;

  private attackBehavior: AiAttackBehavior | null = null;
  private attackRate: number;
  private attackTick: number;
  private triggerRatio: number;
  private reserveRatio: number;
  private expandRatio: number;

  constructor(
    private tribe: Player,
    private protectedPlayerID: PlayerID | null = null,
  ) {
    this.random = new PseudoRandom(simpleHash(tribe.id()));
    this.attackRate = this.random.nextInt(40, 80);
    this.attackTick = this.random.nextInt(0, this.attackRate);
    this.triggerRatio = this.random.nextInt(50, 60) / 100;
    this.reserveRatio = this.random.nextInt(30, 40) / 100;
    this.expandRatio = this.random.nextInt(10, 20) / 100;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  init(mg: Game) {
    this.mg = mg;
  }

  tick(ticks: number) {
    if (ticks % this.attackRate !== this.attackTick) return;

    if (!this.tribe.isAlive()) {
      //removeOnDeath is called from tribe's PlayerExecution
      this.active = false;
      return;
    }

    if (this.attackBehavior === null) {
      this.attackBehavior = new AiAttackBehavior(
        this.random,
        this.mg,
        this.tribe,
        this.triggerRatio,
        this.reserveRatio,
        this.expandRatio,
      );

      // Vassals should answer an attack on their founder immediately rather
      // than spending their first AI action expanding into neutral territory.
      if (this.protectedPlayerID !== null) {
        this.maybeAttack();
        return;
      }

      // Send an attack on the first tick
      this.attackBehavior.sendAttack(this.mg.terraNullius());
      return;
    }

    this.acceptAllAllianceRequests();
    if (this.protectedPlayerID === null) {
      this.deleteNextStructure();
    }
    this.maybeAttack();
  }

  private acceptAllAllianceRequests() {
    // Accept all alliance requests
    for (const req of this.tribe.incomingAllianceRequests()) {
      req.accept();
    }

    // Accept all alliance extension requests
    for (const alliance of this.tribe.alliances()) {
      // Alliance expiration tracked by Events Panel, only human ally can click Request to Renew
      // Skip if no expiration yet/ ally didn't request extension yet / tribe already agreed to extend
      if (!alliance.onlyOneAgreedToExtend()) continue;

      const human = alliance.other(this.tribe);
      this.mg.addExecution(
        new AllianceExtensionExecution(this.tribe, human.id()),
      );
    }
  }

  private deleteNextStructure() {
    if (!this.tribe.canDeleteUnit()) return;
    for (const unit of this.tribe.units()) {
      if (!Structures.has(unit.type())) continue;
      if (unit.isMarkedForDeletion()) continue;
      this.mg.addExecution(new DeleteUnitExecution(this.tribe, unit.id()));
      return;
    }
  }

  private maybeAttack() {
    if (this.attackBehavior === null) {
      throw new Error("not initialized");
    }

    // A vassal's founder is a hard gameplay relationship rather than a normal
    // diplomatic preference. If some other execution has temporarily broken
    // that alliance, do not choose any attack target until the permanent
    // vassal-alliance execution restores it.
    if (this.protectedPlayerID !== null) {
      const protectedPlayer = this.mg.hasPlayer(this.protectedPlayerID)
        ? this.mg.player(this.protectedPlayerID)
        : null;
      if (
        protectedPlayer !== null &&
        !this.tribe.isAlliedWith(protectedPlayer)
      ) {
        return;
      }

      // Founder defense takes priority over normal tribe expansion/aggression.
      // If the vassal cannot launch a land/boat attack against the aggressor,
      // it instead sends only troops that are genuinely spare after reserving
      // enough strength for its own hostile borders and active attackers.
      if (
        protectedPlayer !== null &&
        this.defendProtectedPlayer(protectedPlayer)
      ) {
        return;
      }
    }

    const toAttack = this.attackBehavior.getNeighborTraitorToAttack();
    if (
      toAttack !== null &&
      toAttack.id() !== this.protectedPlayerID
    ) {
      const odds = this.tribe.isFriendly(toAttack) ? 6 : 3;
      if (this.random.chance(odds)) {
        // Check and break alliance before attacking if needed
        const alliance = this.tribe.allianceWith(toAttack);

        if (alliance !== null) {
          this.tribe.breakAlliance(alliance);
        }

        if (this.attackBehavior.sendAttack(toAttack)) return;
      }
    }

    if (this.neighborsTerraNullius) {
      if (this.tribe.nearby().some((n) => !n.isPlayer())) {
        if (this.attackBehavior.sendAttack(this.mg.terraNullius())) return;
      } else {
        this.neighborsTerraNullius = false;
      }
    }

    this.attackBehavior.attackRandomTarget();
  }

  /**
   * Protect the vassal's founder from their current largest attacker.
   *
   * Returns true whenever the founder is under attack, even if the vassal is
   * too threatened to act. This deliberately suppresses unrelated aggression
   * while the founder is in danger.
   */
  private defendProtectedPlayer(founder: Player): boolean {
    if (this.attackBehavior === null) {
      throw new Error("not initialized");
    }

    let largestAttackTroops = 0;
    let totalIncomingTroops = 0;
    let attacker: Player | null = null;

    for (const attack of founder.incomingAttacks()) {
      const candidate = attack.attacker();
      if (candidate === this.tribe || candidate === founder) continue;

      totalIncomingTroops += attack.troops();
      if (attack.troops() > largestAttackTroops) {
        largestAttackTroops = attack.troops();
        attacker = candidate;
      }
    }

    if (attacker === null) return false;

    // Defending the founder overrides the vassal's ordinary diplomacy. If the
    // aggressor happens to be allied with the vassal, end that alliance before
    // trying to retaliate; AttackExecution correctly blocks friendly attacks.
    const alliance = this.tribe.allianceWith(attacker);
    if (alliance !== null) {
      this.tribe.breakAlliance(alliance);
    }

    if (this.attackBehavior.sendAttack(attacker, true)) {
      return true;
    }

    this.sendDefensiveTroopAid(founder, totalIncomingTroops);
    return true;
  }

  private sendDefensiveTroopAid(
    founder: Player,
    founderIncomingTroops: number,
  ): boolean {
    if (!founder.isAlive() || !this.tribe.isFriendly(founder)) return false;
    if (
      this.mg.ticks() - this.lastProtectedPlayerAidTick <
      this.mg.config().donateCooldown()
    ) {
      return false;
    }

    const maxTroops = this.mg.config().maxTroops(this.tribe);
    const baselineReserve = maxTroops * this.reserveRatio;

    // Keep extra troops when a hostile player borders/is immediately nearby.
    // This prevents a vassal from donating itself into an easy conquest just
    // because its founder is fighting elsewhere.
    let strongestBorderEnemy = 0;
    for (const neighbor of this.tribe.nearby()) {
      if (!neighbor.isPlayer()) continue;
      if (this.tribe.isFriendly(neighbor)) continue;
      strongestBorderEnemy = Math.max(
        strongestBorderEnemy,
        neighbor.troops(),
      );
    }

    const incomingToVassal = this.tribe
      .incomingAttacks()
      .filter((attack) => !this.tribe.isFriendly(attack.attacker()))
      .reduce((sum, attack) => sum + attack.troops(), 0);

    const defensiveReserve = Math.max(
      baselineReserve,
      strongestBorderEnemy * 0.8,
      incomingToVassal,
    );
    const spareTroops = Math.floor(this.tribe.troops() - defensiveReserve);
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

    // Vassal reinforcement is part of the vassal relationship, not a manual
    // donation. Use the normal low-level transfer so it still produces the
    // standard donation update, but do not make it depend on the lobby's
    // player-to-player donation toggle. We enforce the same cooldown above.
    if (!this.tribe.donateTroops(founder, troopsToSend)) return false;

    this.lastProtectedPlayerAidTick = this.mg.ticks();
    return true;
  }

  isActive(): boolean {
    return this.active;
  }
}
