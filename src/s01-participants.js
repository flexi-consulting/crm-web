import { readFileSync } from "node:fs";
import { catalog } from "./fixtures.js";

const descriptor = JSON.parse(readFileSync(new URL("../capabilities/s01-exhibition-participants.v1.json", import.meta.url), "utf8"));
export const s01ParticipantCapability = Object.freeze(descriptor);

export function readExhibitionParticipants({ profileId, scopes }, dealIntents) {
  if (!profileId || !Array.isArray(scopes)) return { status: 503, body: { error: "trusted_profile_unavailable" }, error: { code: "AUTH_CONTEXT_UNAVAILABLE", message: "Trusted profile context is unavailable." } };
  if (!s01ParticipantCapability.requiredScopes.every((scope) => scopes.includes(scope))) {
    return { status: 403, body: { error: "required_scope_missing" }, error: { code: "SCOPE_DENIED", message: "Required capability scope is missing." } };
  }
  const items = dealIntents.visibleCompanies(profileId).map((participant) => ({
    ...participant,
    exhibitions: catalog.filter((event) => participant.exhibitionIds.includes(event.id)).map((event) => ({ ...event }))
  }));
  return { status: 200, body: { domainApiVersion: "1.0.0", items } };
}
