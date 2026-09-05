import { EventBus } from "../core/EventBus";
import {
  vassalOwnerIDFromPlayerID,
  vassalOwnerNameFromDisplayName,
} from "../core/game/Vassal";
import { showInGameConfirm } from "./InGameModal";
import { SendAllianceRequestIntentEvent } from "./Transport";
import { translateText } from "./Utils";
import { PlayerView } from "./view";

/**
 * Send an alliance request, redirecting vassal diplomacy to the owning player.
 *
 * The transport event only serializes recipient.id(), so the owner proxy is a
 * deliberately tiny PlayerView-shaped object. The simulation independently
 * enforces the same redirect, making this UI confirmation convenience rather
 * than a security boundary.
 */
export async function sendAllianceRequestWithVassalRedirect(
  eventBus: EventBus,
  requestor: PlayerView,
  recipient: PlayerView,
): Promise<boolean> {
  const ownerID = vassalOwnerIDFromPlayerID(recipient.id());
  if (ownerID === null) {
    eventBus.emit(new SendAllianceRequestIntentEvent(requestor, recipient));
    return true;
  }

  // A founder is permanently allied to its own vassal and cannot request an
  // alliance with itself through the redirect.
  if (ownerID === requestor.id()) return false;

  const ownerName =
    vassalOwnerNameFromDisplayName(recipient.displayName()) ??
    translateText("vassal.owner_fallback");
  const confirmed = await showInGameConfirm(
    translateText("vassal.alliance_redirect_message", { name: ownerName }),
    {
      heading: translateText("vassal.diplomacy_title"),
      variant: "warning",
      confirmText: translateText("vassal.yes"),
      cancelText: translateText("vassal.no"),
    },
  );
  if (!confirmed) return false;

  const ownerRecipient = {
    id: () => ownerID,
  } as PlayerView;
  eventBus.emit(new SendAllianceRequestIntentEvent(requestor, ownerRecipient));
  return true;
}
