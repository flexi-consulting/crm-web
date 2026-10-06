import { createCatalogBuildService } from "./catalog-build.js";
import { createBuiltCatalogD1Repository } from "./built-catalog-d1.js";
import { createS04D1Repository } from "./s04-d1-repository.js";
import { createS04D1ConfirmedDeals } from "./s04-d1-confirmed-deals.js";
import { createDealReviewService } from "./deal-reviews.js";
import { normalizePreleadEventRequest } from "./prelead-timeline.js";
import { renderBuiltCatalogBrowser, browserHeaders } from "./built-catalog-browser.js";

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: {
  "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff"
} });
const validKey = (value) => typeof value === "string" && /^[A-Za-z0-9._:-]{8,128}$/.test(value);
const validContext = (value) => value && typeof value.profileId === "string" && value.profileId.length > 0 &&
  Array.isArray(value.scopes) && value.scopes.every((scope) => typeof scope === "string");

async function input(request) {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
    return { error: "content_type_required", status: 415 };
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > 16_384) return { error: "request_too_large", status: 400 };
  try { return { value: JSON.parse(raw) }; } catch { return { error: "invalid_json", status: 400 }; }
}

// These services are constructed per request in the local Worker. D1 owns state across instances.
export function createBuiltCatalogD1Domain({ db, provider, now }) {
  const catalogBuilds = createBuiltCatalogD1Repository(db, now);
  const repository = createS04D1Repository(db);
  const dealService = createS04D1ConfirmedDeals({ repository, provider, now });
  const reviewService = createDealReviewService({ confirmedDeals: dealService,
    storagePort: repository, participantResolver: catalogBuilds, now });
  const preleads = {
    getTimeline: ({ profileId, preleadId }) => catalogBuilds.getTimeline({ profileRef: profileId, preleadId }),
    async addEvent({ profileId, preleadId, request }) {
      const event = normalizePreleadEventRequest(request);
      if (!event) return { status: 400, body: { error: "invalid_event_request" } };
      const added = event.type === "note_added"
        ? await catalogBuilds.appendNote({ profileRef: profileId, preleadId,
          operationId: event.operationId, noteText: event.noteText })
        : await catalogBuilds.appendDisposition({ profileRef: profileId, preleadId, request: event });
      if (added.status >= 400) return added;
      const timeline = await catalogBuilds.getTimeline({ profileRef: profileId, preleadId });
      if (timeline.status !== 200) return { status: 503, body: { error: "prelead_timeline_unavailable" } };
      const saved = timeline.body.events.find((item) => item.operationId === event.operationId);
      return { status: added.status, body: { domainApiVersion: "1.0.0", prelead: timeline.body.prelead,
        event: saved, operationId: event.operationId, eventCount: timeline.body.events.length,
        replayed: added.status === 200 } };
    },
    async addNote(args) { return this.addEvent(args); }
  };
  return { catalogBuilds, repository, dealService, reviewService, preleads };
}

// Opt-in Fetch adapter. No production entry point imports or enables it.
export function createBuiltCatalogD1HttpHandler({ db, enabled = false, provider, now = () => new Date().toISOString(),
  resolveTrustedProfile, resolveTrustedReviewReceipt } = {}) {
  return async function handle(request) {
    if (!enabled) return reply(404, { error: "not_found" });
    if (!db?.prepare || !db?.batch || !provider?.create) return reply(503, { error: "d1_binding_unavailable" });
    let context;
    try { context = await resolveTrustedProfile?.(request); } catch {}
    if (!validContext(context)) return reply(503, { error: "trusted_profile_unavailable" });
    const url = new URL(request.url);
    const path = url.pathname;
    const built = createBuiltCatalogD1Domain({ db, provider, now });
    const authorize = (scope) => context.scopes.includes(scope) ? null : reply(403, { error: "required_scope_missing" });
    const malformedQuery = () => url.searchParams.size > 0 ? reply(400, { error: "invalid_query" }) : null;
    try {
      if (path.startsWith("/api/v1/legacy-catalog-links/") && request.method === "GET") {
        const denied = authorize("crm.catalog.build.read.synthetic"); if (denied) return denied;
        let eventKey, legacyId;
        try {
          const parts = path.slice("/api/v1/legacy-catalog-links/".length).split("/");
          if (parts.length !== 2) return reply(400, { error: "invalid_legacy_link" });
          [eventKey, legacyId] = parts.map(decodeURIComponent);
        } catch { return reply(400, { error: "invalid_legacy_link" }); }
        const revisions = url.searchParams.getAll("sourceRevision");
        if ([...url.searchParams.keys()].some((key) => key !== "sourceRevision") || revisions.length !== 1 ||
            !/^legacy-ex-sha256-[a-f0-9]{64}$/.test(revisions[0]))
          return reply(400, { error: "source_revision_required" });
        const result = await built.catalogBuilds.resolveLegacyParticipant({ profileRef: context.profileId,
          eventKey, legacyId, sourceRevision: revisions[0] });
        return result.status === 200 ? reply(200, { ...result.body,
          browserPath: `/catalogs/${result.body.buildId}/participants/${result.body.companyId}` })
          : reply(result.status, result.body);
      }
      const browserMatch = path.match(/^\/catalogs\/(build-[a-f0-9]{24})(?:\/participants\/(co-[a-f0-9]{20}))?$/);
      if (browserMatch && request.method === "GET") {
        const denied = authorize("crm.catalog.build.read.synthetic"); if (denied) return denied;
        const query = url.searchParams.getAll("q"), statuses = url.searchParams.getAll("classification");
        if ([...url.searchParams.keys()].some((key) => !["q", "classification"].includes(key)) ||
            query.length > 1 || statuses.length > 1 || browserMatch[2] && url.searchParams.size > 0 ||
            (statuses[0] && !["target", "near_target", "not_target"].includes(statuses[0])))
          return reply(400, { error: "invalid_query" });
        const result = await built.catalogBuilds.readParticipants({ profileRef: context.profileId,
          buildId: browserMatch[1], companyId: browserMatch[2] ?? null,
          query: query[0] ?? "", classification: statuses[0] || null });
        return result.status === 200
          ? new Response(renderBuiltCatalogBrowser(result.body, { query: query[0] ?? "",
            classification: statuses[0] || null, companyId: browserMatch[2] ?? null }),
          { status: 200, headers: browserHeaders })
          : reply(result.status, result.body);
      }
      if (path === "/api/v1/catalog-builds" && request.method === "POST") {
        const denied = authorize("crm.catalog.build.synthetic"); if (denied) return denied;
        const invalidQuery = malformedQuery(); if (invalidQuery) return invalidQuery;
        const key = request.headers.get("idempotency-key");
        if (!validKey(key)) return reply(400, { error: "valid_idempotency_key_required" });
        const parsed = await input(request); if (parsed.error) return reply(parsed.status, { error: parsed.error });
        if (!parsed.value || Object.keys(parsed.value).length !== 1 ||
            !/^demo-expo-[0-9]{3}$/.test(parsed.value.exhibitionId ?? "")) return reply(400, { error: "invalid_catalog_build_request" });
        const prior = await built.catalogBuilds.getBuildByKey({ profileRef: context.profileId, idempotencyKey: key });
        if (prior) return prior.artifact.exhibitionId === parsed.value.exhibitionId
          ? reply(200, { buildId: prior.buildId, artifact: prior.artifact, report: prior.report, replayed: true })
          : reply(409, { error: "idempotency_conflict" });
        const generated = await createCatalogBuildService().build({ profileId: context.profileId,
          idempotencyKey: key, exhibitionId: parsed.value.exhibitionId });
        if (generated.status !== 201) return reply(generated.status, generated.body);
        const saved = await built.catalogBuilds.saveBuild({ profileRef: context.profileId,
          idempotencyKey: key, build: generated.body });
        if (saved.status === "stored") return reply(201, generated.body);
        if (saved.status === "replay") {
          const stored = await built.catalogBuilds.getBuild({ profileRef: context.profileId, buildId: saved.buildId });
          return stored ? reply(200, { buildId: stored.buildId, artifact: stored.artifact,
            report: stored.report, replayed: true }) : reply(503, { error: "catalog_build_unavailable" });
        }
        return reply(saved.status === "storage_unavailable" ? 503 : 409, { error: saved.status });
      }
      const buildMatch = path.match(/^\/api\/v1\/catalog-builds\/(build-[a-f0-9]{24})$/);
      if (buildMatch && (request.method === "GET" || request.method === "HEAD")) {
        const denied = authorize("crm.catalog.build.read.synthetic"); if (denied) return denied;
        const invalidQuery = malformedQuery(); if (invalidQuery) return invalidQuery;
        const stored = await built.catalogBuilds.getBuild({ profileRef: context.profileId, buildId: buildMatch[1] });
        return stored ? reply(200, { buildId: stored.buildId, artifact: stored.artifact,
          report: stored.report, replayed: false }) : reply(404, { error: "catalog_build_not_found" });
      }
      const participantMatch = path.match(/^\/api\/v1\/catalog-builds\/(build-[a-f0-9]{24})\/participants(?:\/(co-[a-f0-9]{20}))?$/);
      if (participantMatch && (request.method === "GET" || request.method === "HEAD")) {
        const denied = authorize("crm.catalog.build.read.synthetic"); if (denied) return denied;
        const q = url.searchParams.getAll("q"), classification = url.searchParams.getAll("classification");
        if ([...url.searchParams.keys()].some((key) => !["q", "classification"].includes(key)) || q.length > 1 ||
            classification.length > 1 || (participantMatch[2] && url.searchParams.size > 0)) return reply(400, { error: "invalid_query" });
        const result = await built.catalogBuilds.readParticipants({ profileRef: context.profileId,
          buildId: participantMatch[1], companyId: participantMatch[2] ?? null,
          query: q[0] ?? "", classification: classification[0] ?? null });
        return reply(result.status, result.body);
      }
      const bindMatch = path.match(/^\/api\/v1\/catalog-builds\/(build-[a-f0-9]{24})\/participants\/(co-[a-f0-9]{20})\/prelead$/);
      if (bindMatch && request.method === "POST") {
        const denied = authorize("crm.preleads.create.synthetic"); if (denied) return denied;
        const invalidQuery = malformedQuery(); if (invalidQuery) return invalidQuery;
        const parsed = await input(request); if (parsed.error) return reply(parsed.status, { error: parsed.error });
        if (!parsed.value || Object.keys(parsed.value).length !== 0) return reply(400, { error: "invalid_request" });
        const result = await built.catalogBuilds.ensurePrelead({ profileRef: context.profileId,
          buildId: bindMatch[1], companyId: bindMatch[2] });
        return reply(result.status, result.body);
      }
      const timelineMatch = path.match(/^\/api\/v1\/preleads\/(built-prelead-[a-f0-9]{24})\/timeline$/);
      if (timelineMatch && (request.method === "GET" || request.method === "HEAD")) {
        const denied = authorize("crm.preleads.read"); if (denied) return denied;
        const invalidQuery = malformedQuery(); if (invalidQuery) return invalidQuery;
        const result = await built.preleads.getTimeline({ profileId: context.profileId, preleadId: timelineMatch[1] });
        return reply(result.status, result.body);
      }
      const noteMatch = path.match(/^\/api\/v1\/preleads\/(built-prelead-[a-f0-9]{24})\/events$/);
      if (noteMatch && request.method === "POST") {
        const denied = authorize("crm.preleads.events.append"); if (denied) return denied;
        const invalidQuery = malformedQuery(); if (invalidQuery) return invalidQuery;
        const parsed = await input(request); if (parsed.error) return reply(parsed.status, { error: parsed.error });
        const result = await built.preleads.addEvent({ profileId: context.profileId,
          preleadId: noteMatch[1], request: parsed.value });
        return reply(result.status, result.body);
      }
      if (path === "/api/v1/deal-reviews" && request.method === "POST") {
        const denied = authorize("crm.deals.review.synthetic"); if (denied) return denied;
        const invalidQuery = malformedQuery(); if (invalidQuery) return invalidQuery;
        const parsed = await input(request); if (parsed.error) return reply(parsed.status, { error: parsed.error });
        const result = await built.reviewService.prepare({ profileId: context.profileId, request: parsed.value });
        return reply(result.status, result.body);
      }
      const reviewMatch = path.match(/^\/api\/v1\/deal-reviews\/(review-[0-9a-f-]{36})$/);
      if (reviewMatch && (request.method === "GET" || request.method === "HEAD")) {
        const denied = authorize("crm.deals.review.synthetic"); if (denied) return denied;
        const invalidQuery = malformedQuery(); if (invalidQuery) return invalidQuery;
        const result = await built.reviewService.get({ profileId: context.profileId, reviewId: reviewMatch[1] });
        return reply(result.status, result.body);
      }
      const confirmMatch = path.match(/^\/api\/v1\/deal-reviews\/(review-[0-9a-f-]{36})\/confirm$/);
      if (confirmMatch && request.method === "POST") {
        const denied = authorize("crm.deals.confirm.synthetic"); if (denied) return denied;
        const invalidQuery = malformedQuery(); if (invalidQuery) return invalidQuery;
        const parsed = await input(request); if (parsed.error) return reply(parsed.status, { error: parsed.error });
        if (!parsed.value || Object.keys(parsed.value).length !== 1 || typeof parsed.value.revision !== "string")
          return reply(400, { error: "invalid_review_confirmation" });
        let trustedReceipt;
        try { trustedReceipt = await resolveTrustedReviewReceipt?.(request, context,
          confirmMatch[1], parsed.value.revision); } catch {}
        const result = await built.reviewService.confirm({ profileId: context.profileId,
          reviewId: confirmMatch[1], revision: parsed.value.revision, trustedReceipt });
        return reply(result.status, result.body);
      }
      const operationMatch = path.match(/^\/api\/v1\/deal-operations\/(op-[0-9a-f-]{36})(?:\/(reconcile|repair))?$/);
      if (operationMatch && (request.method === "GET" || request.method === "POST")) {
        const mode = operationMatch[2] ?? "get";
        if ((mode === "get" && request.method !== "GET") || (mode !== "get" && request.method !== "POST"))
          return reply(405, { error: "method_not_allowed" });
        const denied = authorize(mode === "repair" ? "crm.deals.links.repair.synthetic" : "crm.deals.operations.read.synthetic");
        if (denied) return denied;
        const result = await built.dealService[mode]({ profileId: context.profileId, operationId: operationMatch[1] });
        return reply(result.status, result.body);
      }
      return reply(404, { error: "not_found" });
    } catch { return reply(503, { error: "domain_unavailable" }); }
  };
}
