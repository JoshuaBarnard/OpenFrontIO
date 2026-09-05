import {
  Execution,
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  Structures,
  Unit,
} from "../game/Game";
import { CityExecution } from "./CityExecution";
import { PlayerExecution } from "./PlayerExecution";
import { TribeExecution } from "./TribeExecution";
import { VassalAllianceExecution } from "./VassalAllianceExecution";

/** Radius, in map tiles, transferred from the founder to a new vassal. */
export const VASSAL_FOUNDING_RADIUS = 20;

/**
 * Converts the completed founding city and nearby founder-owned territory into
 * a new autonomous bot player. Enemy and neutral territory is never touched.
 */
export class VassalFoundingExecution implements Execution {
  private active = true;
  private mg: Game;

  constructor(
    private founder: Player,
    private capital: Unit,
  ) {}

  init(mg: Game): void {
    this.mg = mg;
  }

  tick(): void {
    this.active = false;

    // The construction execution follows ownership if the structure is
    // captured while being built, so the player passed here is the owner at
    // completion. Re-check before changing any territory in case the city was
    // destroyed/captured again before this execution got its tick.
    if (!this.capital.isActive() || this.capital.owner() !== this.founder) {
      return;
    }

    const center = this.capital.tile();
    if (this.mg.owner(center) !== this.founder) {
      return;
    }

    const vassalID = `vassal-${this.founder.id()}-${this.capital.id()}`;
    if (this.mg.hasPlayer(vassalID)) {
      return;
    }

    const vassal = this.mg.addPlayer(
      new PlayerInfo(
        `Vassal ${this.capital.id()}`,
        PlayerType.Bot,
        null,
        vassalID,
      ),
    );

    const transferred = new Set<number>();
    const centerX = this.mg.x(center);
    const centerY = this.mg.y(center);
    const radius = VASSAL_FOUNDING_RADIUS;
    const radiusSquared = radius * radius;

    for (let y = centerY - radius; y <= centerY + radius; y++) {
      for (let x = centerX - radius; x <= centerX + radius; x++) {
        if (!this.mg.isValidCoord(x, y)) continue;

        const dx = x - centerX;
        const dy = y - centerY;
        if (dx * dx + dy * dy > radiusSquared) continue;

        const tile = this.mg.ref(x, y);
        if (this.mg.owner(tile) !== this.founder) continue;

        this.founder.relinquish(tile);
        vassal.conquer(tile);
        transferred.add(tile);
      }
    }

    // The capital tile is guaranteed to be founder-owned above, so at least
    // that tile must transfer. Keep the guard defensive in case future
    // territory rules change.
    if (!transferred.has(center)) {
      return;
    }

    // Buildings inside the granted territory become the vassal's property as
    // well. Mobile units are deliberately left with the founder.
    for (const unit of this.mg.units()) {
      if (unit.owner() !== this.founder) continue;
      if (!Structures.has(unit.type())) continue;
      if (!transferred.has(unit.tile())) continue;
      unit.setOwner(vassal);
    }

    vassal.setSpawnTile(center);
    this.founder.updateRelation(vassal, 100);
    vassal.updateRelation(this.founder, 100);

    const allianceRequest = this.founder.createAllianceRequest(vassal);
    allianceRequest?.accept();

    // Add the permanent relationship execution before the AI so a restored
    // alliance is in place before the vassal chooses any targets that tick.
    this.mg.addExecution(new PlayerExecution(vassal));
    this.mg.addExecution(new VassalAllianceExecution(this.founder, vassal));
    this.mg.addExecution(new TribeExecution(vassal, this.founder.id()));
    this.mg.addExecution(new CityExecution(this.capital));
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
