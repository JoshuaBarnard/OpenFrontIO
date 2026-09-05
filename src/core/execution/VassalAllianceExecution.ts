import { Execution, Game, Player } from "../game/Game";

/**
 * Keeps a founded vassal permanently friendly with its founder.
 *
 * Vassals intentionally reuse the normal alliance relation so every existing
 * attack, donation, border and UI path understands the relationship. The
 * execution simply restores a manually-broken alliance and renews it before
 * the normal expiry window can close.
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

    let alliance = this.founder.allianceWith(this.vassal);
    if (alliance === null) {
      const request = this.founder.createAllianceRequest(this.vassal);
      request?.accept();
      alliance = this.founder.allianceWith(this.vassal);
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
