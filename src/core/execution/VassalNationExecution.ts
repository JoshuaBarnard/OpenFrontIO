import {
  Execution,
  Game,
  Player,
  PlayerID,
  Structures,
} from "../game/Game";
import { PseudoRandom } from "../PseudoRandom";
import { simpleHash } from "../Util";
import { NationStructureBehavior } from "./nation/NationStructureBehavior";
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

    if (this.attackBehavior === null || this.structureBehavior === null) {
      this.attackBehavior = new AiAttackBehavior(
        this.random,
        this.mg,
        this.vassal,
        this.triggerRatio,
        this.reserveRatio,
        this.expandRatio,
      );
      this.structureBehavior = new NationStructureBehavior(
        this.random,
        this.mg,
        this.vassal,
      );

      // Give the new vassal one immediate useful decision. Founder defence
      // wins over expansion if the founder is already under attack.
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
        this.structureBehavior.handleStructures();
      }
      return;
    }

    // Vassals use the real Nation structure planner, so they can build and
    // upgrade Cities, Factories, Ports, SAMs and Missile Silos like nations.
    this.structureBehavior.handleStructures();

    // An attack on the founder takes priority over unrelated aggression.
    if (this.defendFounder()) return;

    this.maybeAttack();
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

    if (!this.vassal.isFriendly(attacker)) {
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
      if (this.vassal.isFriendly(neighbor)) continue;
      if (!this.vassal.sharesBorderWith(neighbor)) continue;
      strongestBorderEnemy = Math.max(
        strongestBorderEnemy,
        neighbor.troops(),
      );
    }

    const incomingToVassal = this.vassal
      .incomingAttacks()
      .filter((attack) => !this.vassal.isFriendly(attack.attacker()))
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
      if (this.random.chance(this.vassal.isFriendly(traitor) ? 6 : 3)) {
        if (this.attackBehavior.sendAttack(traitor)) return;
      }
    }

    if (this.neighborsTerraNullius) {
      if (this.vassal.nearby().some((neighbor) => !neighbor.isPlayer())) {
        if (this.attackBehavior.sendAttack(this.mg.terraNullius())) return;
      } else {
        this.neighborsTerraNullius = false;
      }
    }

    this.attackBehavior.attackRandomTarget();
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
