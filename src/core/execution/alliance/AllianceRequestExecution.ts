import {
  AllianceRequest,
  Execution,
  Game,
  MessageType,
  Player,
  PlayerID,
  UnitType,
} from "../../game/Game";
import { vassalOwnerIDFromPlayerID } from "../../game/Vassal";
import { wouldNukeBreakAlliance } from "../Util";

export class AllianceRequestExecution implements Execution {
  private req: AllianceRequest | null = null;
  private active = true;
  private mg: Game;

  constructor(
    private requestor: Player,
    private recipientID: PlayerID,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;

    // Vassals never own diplomacy. This also blocks old/malicious clients and
    // AI paths from making a vassal originate an independent request.
    if (vassalOwnerIDFromPlayerID(this.requestor.id()) !== null) {
      console.warn("vassals cannot send alliance requests");
      this.active = false;
      return;
    }

    // Requests aimed at a vassal belong to its owner. Modern clients ask for
    // confirmation before sending; this redirect is the simulation-side rule
    // that guarantees there can never be a direct vassal alliance request.
    const vassalOwnerID = vassalOwnerIDFromPlayerID(this.recipientID);
    if (vassalOwnerID !== null) {
      if (!mg.hasPlayer(vassalOwnerID) || vassalOwnerID === this.requestor.id()) {
        this.active = false;
        return;
      }
      this.recipientID = vassalOwnerID;
    }

    if (!mg.hasPlayer(this.recipientID)) {
      console.warn(
        `AllianceRequestExecution recipient ${this.recipientID} not found`,
      );
      this.active = false;
      return;
    }

    const recipient = mg.player(this.recipientID);

    if (!this.requestor.canSendAllianceRequest(recipient)) {
      console.warn("cannot send alliance request");
      this.active = false;
    } else {
      const incoming = recipient
        .outgoingAllianceRequests()
        .find((r) => r.recipient() === this.requestor);
      if (incoming) {
        // If the recipient already has pending alliance request,
        // then accept it instead of creating a new one.
        this.active = false;
        incoming.accept();

        // Update player relations
        this.requestor.updateRelation(recipient, 100);
        recipient.updateRelation(this.requestor, 100);

        // Automatically remove embargoes only if they were automatically created
        if (this.requestor.hasEmbargoAgainst(recipient))
          this.requestor.endTemporaryEmbargo(recipient);
        if (recipient.hasEmbargoAgainst(this.requestor))
          recipient.endTemporaryEmbargo(this.requestor);

        // Cancel incoming nukes between players
        this.cancelNukesBetweenAlliedPlayers(recipient);
      } else {
        this.req = this.requestor.createAllianceRequest(recipient);
      }
    }
  }

  tick(ticks: number): void {
    if (
      this.req?.status() === "accepted" ||
      this.req?.status() === "rejected"
    ) {
      this.active = false;
      return;
    }
    if (
      this.mg.ticks() - (this.req?.createdAt() ?? 0) >
      this.mg.config().allianceRequestDuration()
    ) {
      this.req?.reject();
      this.active = false;
    }
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  cancelNukesBetweenAlliedPlayers(recipient: Player): void {
    const neutralized = new Map<Player, number>();
    const cancelledWarheadLaunchers = new Set<Player>();

    const players = [this.requestor, recipient];

    for (const launcher of players) {
      const other = launcher === this.requestor ? recipient : this.requestor;

      for (const unit of launcher.units([
        UnitType.AtomBomb,
        UnitType.HydrogenBomb,
        UnitType.MIRV,
        UnitType.MIRVWarhead,
      ])) {
        if (!unit.isActive() || unit.reachedTarget()) continue;

        const targetTile = unit.targetTile();

        if (unit.type() === UnitType.MIRV) {
          // Compare against the captured target player at launch rather than
          // the tile's current owner, so tile ownership changes mid-flight
          // (e.g. from third-party conquest or fallout) don't skip cancellation
          // while the MIRV continues seeking the newly allied player's tiles.
          const target =
            unit.targetPlayer() ??
            (targetTile ? this.mg.owner(targetTile) : null);
          if (target !== other) continue;
        } else if (unit.type() === UnitType.MIRVWarhead) {
          if (!targetTile || this.mg.owner(targetTile) !== other) continue;
        } else {
          if (!targetTile) continue;
          const magnitude = this.mg.config().nukeMagnitudes(unit.type());
          if (
            !wouldNukeBreakAlliance({
              game: this.mg,
              targetTile,
              magnitude,
              allySmallIds: new Set([other.smallID()]),
              threshold: this.mg.config().nukeAllianceBreakThreshold(),
            })
          ) {
            continue;
          }
        }

        unit.delete(false);
        if (unit.type() === UnitType.MIRVWarhead) {
          cancelledWarheadLaunchers.add(launcher);
        } else {
          neutralized.set(launcher, (neutralized.get(launcher) ?? 0) + 1);
        }
      }
    }

    for (const launcher of cancelledWarheadLaunchers) {
      neutralized.set(launcher, (neutralized.get(launcher) ?? 0) + 1);
    }

    for (const [launcher, count] of neutralized) {
      const other = launcher === this.requestor ? recipient : this.requestor;

      this.mg.displayMessage(
        "events_display.alliance_nukes_destroyed_outgoing",
        MessageType.ALLIANCE_ACCEPTED,
        launcher.id(),
        undefined,
        { name: other.displayName(), count },
        undefined,
        other.id(),
      );

      this.mg.displayMessage(
        "events_display.alliance_nukes_destroyed_incoming",
        MessageType.ALLIANCE_ACCEPTED,
        other.id(),
        undefined,
        { name: launcher.displayName(), count },
        undefined,
        launcher.id(),
      );
    }
  }
}
