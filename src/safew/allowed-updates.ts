import { API_CONSTANTS } from "grammy";

type SafewUpdateType = (typeof API_CONSTANTS.ALL_UPDATE_TYPES)[number];

export function resolveSafewAllowedUpdates(): ReadonlyArray<SafewUpdateType> {
  const updates = [...API_CONSTANTS.DEFAULT_UPDATE_TYPES] as SafewUpdateType[];
  if (!updates.includes("message_reaction")) {
    updates.push("message_reaction");
  }
  return updates;
}
