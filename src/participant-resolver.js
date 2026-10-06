import { createHash } from "node:crypto";
import { catalog, companies, syntheticProfileCompanies } from "./fixtures.js";

const builtId = (profileId, exhibitionId, companyId) => `built-prelead-${createHash("sha256").update(JSON.stringify([profileId, exhibitionId, companyId])).digest("hex").slice(0, 24)}`;

// One profile/event/company resolver for synthetic catalog actions. buildId pins a validated revision.
export function createParticipantResolver({ catalogBuilds, preleadTimeline }) {
  function resolve({ profileId, exhibitionId, companyId, buildId = null }) {
    const exhibition = catalog.find((item) => item.id === exhibitionId);
    if (!exhibition) return null;
    if (buildId) {
      if (!/^co-[a-f0-9]{20}$/.test(companyId)) return null;
      const result = catalogBuilds.readParticipants({ profileId, buildId, companyId });
      if (result.status !== 200 || result.body.exhibitionId !== exhibitionId) return null;
      return { exhibition, company: result.body.items[0], buildId,
        preleadId: builtId(profileId, exhibitionId, companyId) };
    }
    if (!/^demo-company-[0-9]{3}$/.test(companyId) || !(syntheticProfileCompanies[profileId] ?? []).includes(companyId)) return null;
    const company = companies.find((item) => item.id === companyId && item.exhibitionIds.includes(exhibitionId));
    return company ? { exhibition, company, buildId: null, preleadId: `demo-prelead-${companyId.slice(-3)}` } : null;
  }
  function ensureBuiltPrelead({ profileId, exhibitionId, companyId, buildId }) {
    if (!buildId) return { status: 400, body: { error: "build_id_required" } };
    const selected = resolve({ profileId, exhibitionId, companyId, buildId });
    if (!selected) return { status: 404, body: { error: "participant_not_found" } };
    return preleadTimeline.ensurePrelead({ id: selected.preleadId, profileId, companyId, exhibitionId, buildId, stage: "draft" });
  }
  return { resolve, ensureBuiltPrelead };
}
