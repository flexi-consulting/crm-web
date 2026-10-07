import { createCatalogBuildService } from "../src/catalog-build.js";
import { createBuiltCatalogD1Repository } from "../src/built-catalog-d1.js";
import { createS04D1Repository } from "../src/s04-d1-repository.js";
import { createS04D1ConfirmedDeals } from "../src/s04-d1-confirmed-deals.js";
import { createDealReviewService } from "../src/deal-reviews.js";
import { importLegacyExSnapshot, importLegacyExSnapshotV11 } from "../src/legacy-ex-snapshot.js";
import { createCatalogV11D1Repository, createCatalogV11ReadHandler,
  createCatalogV11SearchHandler } from "../src/catalog-query-v11.js";
import { importReviewedLegacyExSnapshot } from "../src/legacy-import-approval.js";

const now = "2026-10-06T09:00:00.000Z";
let providerCalls = 0;
const respond = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Wrangler local contract fixture only. Each request gets fresh service objects, as separate instances would.
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/health") return respond(200, { ok: true });
    if (/^\/catalogs\/[a-z0-9][a-z0-9-]{0,79}$/.test(path) ||
        /^\/api\/v1\/catalogs\/[a-z0-9][a-z0-9-]{0,79}\/entries$/.test(path)) {
      const repository = createCatalogV11D1Repository(env.CRM_DB, () => now);
      const resolveTrustedProfile = async request => ({
        profileId: request.headers.get("x-test-profile") ?? "demo-profile-a",
        scopes: (request.headers.get("x-test-scopes") ?? "crm.catalog.read").split(" ").filter(Boolean)
      });
      const read = createCatalogV11ReadHandler({ repository, resolveTrustedProfile });
      const search = createCatalogV11SearchHandler({ repository, resolveTrustedProfile });
      return path.startsWith("/api/") ? search(request) : read(request);
    }
    let args;
    try { args = await request.json(); } catch { return respond(400, { error: "invalid_json" }); }
    const profileId = request.headers.get("x-test-profile") ?? "demo-profile-a";
    const built = createBuiltCatalogD1Repository(env.CRM_DB, () => now);
    const catalogV11 = createCatalogV11D1Repository(env.CRM_DB, () => now);
    const s04 = createS04D1Repository(env.CRM_DB);
    const provider = { async create({ operationId, request: deal }) {
      providerCalls++;
      if (deal.title === "Unknown built outcome") throw new Error("synthetic_timeout_after_reservation");
      return { status: "created", dealId: `demo-deal-${operationId.slice(3)}` };
    } };
    const deals = createS04D1ConfirmedDeals({ repository: s04, provider, now: () => now });
    const reviews = createDealReviewService({ confirmedDeals: deals, storagePort: s04,
      participantResolver: built, now: () => now });
    try {
      let result;
      if (path === "/catalog/build") {
        const key = args.idempotencyKey;
        const generated = await createCatalogBuildService().build({ profileId, idempotencyKey: key,
          exhibitionId: args.exhibitionId });
        if (generated.status !== 201) return respond(generated.status, generated.body);
        if (args.reverseArtifact === true) generated.body.artifact.companies.reverse();
        result = await built.saveBuild({ profileRef: profileId, idempotencyKey: key, build: generated.body });
        return respond(result.status === "stored" ? 201 : result.status === "replay" ? 200 : 409, result);
      }
      if (path === "/catalog/import-legacy") {
        result = await importLegacyExSnapshot({ repository: built, profileRef: profileId,
          eventKey: args.eventKey, entries: args.entries });
        return respond(result.status === "stored" ? 201 : result.status === "replay" ? 200 : 422, result);
      }
      if (path === "/catalog/import-legacy-v11") {
        result = await importLegacyExSnapshotV11({ repository: catalogV11, profileRef: profileId,
          eventKey: args.eventKey, entries: args.entries });
        return respond(result.status === "stored" ? 201 : result.status === "replay" ? 200 : 422, result);
      }
      if (path === "/catalog/import-reviewed-legacy") {
        const { sourceBytesBase64, ...review } = args;
        let sourceBytes;
        try { sourceBytes = Buffer.from(sourceBytesBase64, "base64"); }
        catch { return respond(400, { error: "invalid_source_bytes" }); }
        try { sourceBytes = Buffer.from(sourceBytesBase64, "base64"); } catch { return respond(400, { error: "invalid_source_bytes" }); }
        result = await importReviewedLegacyExSnapshot({ repository: built, ...review, sourceBytes });
        return respond(result.status === "stored" ? 201 : result.status === "replay" ? 200 : 422, result);
      }
      if (path === "/catalog/resolve-legacy") result = await built.resolveLegacyParticipant({
        profileRef: profileId, eventKey: args.eventKey, legacyId: args.legacyId });
      else if (path === "/catalog/read") result = await built.readParticipants({ profileRef: profileId, buildId: args.buildId,
        companyId: args.companyId ?? null, query: args.q ?? "", classification: args.classification ?? null });
      else if (path === "/catalog/bind") result = await built.ensurePrelead({ profileRef: profileId,
        buildId: args.buildId, companyId: args.companyId });
      else if (path === "/prelead/note") result = await built.appendNote({ profileRef: profileId,
        preleadId: args.preleadId, operationId: args.operationId, noteText: args.noteText });
      else if (path === "/prelead/context") {
        const context = await s04.getPreleadContext({ profileRef: profileId,
          eventId: args.exhibitionId, companyId: args.companyId });
        result = context ? { status: 200, body: context } : { status: 404, body: { error: "prelead_not_found" } };
      } else if (path === "/review/prepare") result = await reviews.prepare({ profileId, request: args });
      else if (path === "/review/get") result = await reviews.get({ profileId, reviewId: args.reviewId });
      else if (path === "/review/confirm") {
        const approved = request.headers.get("x-test-approval") === "approved";
        const trustedReceipt = approved ? { profileId, reviewId: args.reviewId,
          revision: args.revision, actorId: "synthetic-actor", issuerId: "local-built-catalog-test",
          receiptId: `receipt-${args.reviewId.slice(7)}`, approved: true,
          issuedAt: now, expiresAt: "2027-01-01T00:00:00.000Z" } : undefined;
        result = await reviews.confirm({ profileId, reviewId: args.reviewId,
          revision: args.revision, trustedReceipt });
      } else if (path === "/operation/get") result = await deals.get({ profileId, operationId: args.operationId });
      else if (path === "/provider/count") result = { status: 200, body: { calls: providerCalls } };
      else result = { status: 404, body: { error: "not_found" } };
      return respond(result.status, result.body);
    } catch (error) { return respond(500, { error: "local_contract_failure", detail: String(error?.message ?? error) }); }
  }
};
