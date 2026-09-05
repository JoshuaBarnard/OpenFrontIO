import {
  Execution,
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  Structures,
  Unit,
} from "../game/Game";
import {
  makeVassalDisplayName,
  makeVassalPlayerID,
} from "../game/Vassal";
import { CityExecution } from "./CityExecution";
import { PlayerExecution } from "./PlayerExecution";
import { VassalAllianceExecution } from "./VassalAllianceExecution";
import { VassalNationExecution } from "./VassalNationExecution";

/** Radius, in map tiles, transferred from the founder to a new vassal. */
export const VASSAL_FOUNDING_RADIUS = 20;

/**
 * Converts the completed founding city and nearby founder-owned territory into
 * a new autonomous nation vassal. Enemy and neutral territory is never touched.
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

    const vassalID = makeVassalPlayerID(this.founder.id(), this.capital.id());
    if (this.mg.hasPlayer(vassalID)) {
      return;
    }

    const vassalInfo = new PlayerInfo(
      makeVassalDisplayName(this.founder.displayName()),
      PlayerType.Nation,
      null,
      vassalID,
    );

    // GameImpl already supports an explicit team argument even though the
    // public Game interface still exposes the one-argument form. Preserve the
    // founder's team so a dynamically-created Nation never falls into a
    // generic Nation/Bot team in team modes.
    const addPlayerWithTeam = this.mg.addPlayer as unknown as (
      playerInfo: PlayerInfo,
      team: ReturnType<Player["team"]>,
    ) => Player;
    const vassal = addPlayerWithTeam.call(
      this.mg,
      vassalInfo,
      this.founder.team(),
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

    // Diplomacy runs before the vassal AI so mirrored alliances are corrected
    // before the vassal chooses combat targets on a tick.
    this.mg.addExecution(new PlayerExecution(vassal));
    this.mg.addExecution(new VassalAllianceExecution(this.founder, vassal));
    this.mg.addExecution(new VassalNationExecution(vassal, this.founder.id()));
    this.mg.addExecution(new CityExecution(this.capital));
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
