import { Execution, Game, Player } from "../game/Game";

/**
 * Makes a vassal's alliances a projection of its founder's diplomacy.
 *
 * The vassal is permanently allied to its founder. Every other alliance is
 * created/removed to match the founder, and direct requests to the vassal are
 * rejected because vassals never negotiate independently.
 */
export class VassalAllianceExecution implements Execution {
  private active = true;
  private mg: Game;

  constructor(
    private founder: Player,
    private vassal: Player,
  ) {}

  init(mg: Game): void {
    this.mg = mg;
  }

  tick(): void {
    if (!this.vassal.isAlive()) {
      this.active = false;
      return;
    }

    // Clear any stale/direct requests. New client and simulation requests are
    // redirected to the founder before reaching this point, but this keeps old
    // clients and unusual execution ordering from giving a vassal diplomacy.
    for (const request of this.vassal.incomingAllianceRequests()) {
      request.reject();
    }
    for (const request of this.vassal.outgoingAllianceRequests()) {
      request.reject();
    }

    this.ensureAlliance(this.founder);

    // Mirror every current founder alliance onto the vassal. The founder's own
    // vassal alliance is excluded from this set because it is handled above.
    const desiredAllies = new Set(
      this.founder
        .allies()
        .filter((ally) => ally !== this.vassal && ally.isAlive()),
    );

    for (const ally of desiredAllies) {
      this.ensureAlliance(ally);
    }

    // A vassal cannot keep independent alliances. Expire, rather than betray,
    // anything its founder no longer has so no traitor penalty is generated.
    for (const alliance of [...this.vassal.alliances()]) {
      const other = alliance.other(this.vassal);
      if (other === this.founder) continue;
      if (desiredAllies.has(other)) continue;
      alliance.expire();
    }
  }

  private ensureAlliance(other: Player): void {
    let alliance = this.vassal.allianceWith(other);
    if (alliance === null) {
      const request = this.vassal.createAllianceRequest(other);
      request?.accept();
      alliance = this.vassal.allianceWith(other);
    }

    if (
      alliance !== null &&
      alliance.expiresAt() <=
        this.mg.ticks() + this.mg.config().allianceExtensionPromptOffset()
    ) {
      alliance.extend();
    }
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
