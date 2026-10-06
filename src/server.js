import { createServer as nodeCreateServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { catalog } from "./fixtures.js";
import { createDealIntentService, isDealIntentRequest } from "./deal-intents.js";
import { createPreleadTimelineService, normalizePreleadEventRequest } from "./prelead-timeline.js";
import { createConfirmedDealService, normalizeConfirmedDealRequest } from "./confirmed-deals.js";
import { createCatalogBuildService } from "./catalog-build.js";
import { s01ParticipantCapability, readExhibitionParticipants } from "./s01-participants.js";
import { createDealReviewService, normalizeDealReviewRequest } from "./deal-reviews.js";
import { createParticipantResolver } from "./participant-resolver.js";

const manifest = {
  serviceId: "crm-web.exhibitions",
  release: {
    version: process.env.CRM_WEB_RELEASE_VERSION ?? "0.1.0",
    sourceRevision: process.env.CRM_WEB_SOURCE_REVISION ?? "working-tree",
    environment: process.env.CRM_WEB_ENVIRONMENT ?? "development"
  },
  platformContractRange: ">=1.0.0 <2.0.0",
  domainApiVersion: "1.0.0",
  // Synthetic prelead and deal-intent routes are deliberately not discoverable capabilities.
  capabilities: [
    {
      id: "exhibitions.catalog.read", version: "1.0.0", required: true,
      inputSchemaRef: "schemas/catalog-query.schema.json", outputSchemaRef: "schemas/catalog.schema.json",
      effect: "read", requiredScopes: [], operationRef: "GET /api/v1/catalog"
    },
    {
      id: "crm.companies.read", version: "1.0.0", required: true,
      inputSchemaRef: "schemas/company-query.schema.json", outputSchemaRef: "schemas/company-list.schema.json",
      effect: "read", requiredScopes: ["crm.companies.read"], operationRef: "GET /api/v1/companies"
    },
    {
      id: s01ParticipantCapability.capabilityId, version: s01ParticipantCapability.version, required: true,
      inputSchemaRef: s01ParticipantCapability.inputSchemaRef, outputSchemaRef: s01ParticipantCapability.outputSchemaRef,
      errorsSchemaRef: s01ParticipantCapability.errorsSchemaRef, descriptorRef: "capabilities/s01-exhibition-participants.v1.json",
      handlerBinding: s01ParticipantCapability.handlerBinding, mcpTool: s01ParticipantCapability.mcpTool,
      effect: s01ParticipantCapability.effect, requiredScopes: s01ParticipantCapability.requiredScopes, operationRef: s01ParticipantCapability.httpBinding
    },
    {
      id: "crm.company.read", version: "1.0.0", required: false,
      inputSchemaRef: "schemas/company-query.schema.json", outputSchemaRef: "schemas/company.schema.json",
      effect: "read", requiredScopes: ["crm.companies.read"], operationRef: "GET /api/v1/companies/{id}"
    },
  ],
  readiness: {
    status: "ready",
    scope: "local_process_only",
    reason: { code: "local_process_available" },
    checked: {
      serviceId: "crm-web.exhibitions",
      release: {
        version: process.env.CRM_WEB_RELEASE_VERSION ?? "0.1.0",
        sourceRevision: process.env.CRM_WEB_SOURCE_REVISION ?? "working-tree",
        environment: process.env.CRM_WEB_ENVIRONMENT ?? "development"
      },
      platformContractRange: ">=1.0.0 <2.0.0",
      domainApiVersion: "1.0.0"
    }
  },
  compatibility: { deprecatedCapabilities: [] },
  endpoints: {
    readiness: { method: "GET", path: "/api/v1/readiness" },
    catalog: { method: "GET", path: "/api/v1/catalog" }
  }
};

function json(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const contentType = request.headers["content-type"] ?? "";
  if (contentType.toLowerCase().split(";")[0].trim() !== "application/json") return { error: "content_type_required" };
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 16_384) return { error: "request_too_large" };
  }
  try { return { value: JSON.parse(raw) }; }
  catch { return { error: "invalid_json" }; }
}

export function createServer({
  resolveTrustedProfile,
  resolveTrustedReviewReceipt,
  allowUnsafeSyntheticConfirm = false,
  dealIntents = createDealIntentService(),
  catalogBuilds = createCatalogBuildService(),
  preleadTimeline = createPreleadTimelineService(),
  confirmedDeals,
  reviewService
} = {}) {
  const participantResolver = createParticipantResolver({ catalogBuilds, preleadTimeline });
  const dealService = confirmedDeals ?? createConfirmedDealService({ preleadTimeline, participantResolver });
  const dealReviews = reviewService ?? createDealReviewService({ confirmedDeals: dealService, preleadTimeline, participantResolver });
  async function trustedProfile(request, response, requiredScope) {
    if (!resolveTrustedProfile) {
      json(response, 503, { error: "trusted_profile_unavailable" });
      return null;
    }
    try {
      const context = await resolveTrustedProfile(request);
      if (context && typeof context.profileId === "string" && context.profileId.length > 0 &&
          Array.isArray(context.scopes) && context.scopes.every((scope) => typeof scope === "string")) {
        if (context.scopes.includes(requiredScope)) return context;
        json(response, 403, { error: "required_scope_missing" });
        return null;
      }
    } catch { /* Fail closed without exposing resolver details. */ }
    json(response, 503, { error: "trusted_profile_unavailable" });
    return null;
  }

  return nodeCreateServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const isCreateIntent = url.pathname === "/api/v1/deal-intents" && request.method === "POST";
    const timelineEventMatch = url.pathname.match(/^\/api\/v1\/preleads\/((?:demo-prelead-[0-9]{3}|built-prelead-[a-f0-9]{24}))\/events$/);
    const isAppendPreleadEvent = Boolean(timelineEventMatch) && request.method === "POST";
    const isConfirmDeal = url.pathname === "/api/v1/deals/confirm" && request.method === "POST";
    const isPrepareReview = url.pathname === "/api/v1/deal-reviews" && request.method === "POST";
    const reviewMatch = url.pathname.match(/^\/api\/v1\/deal-reviews\/(review-[0-9a-f-]{36})$/);
    const reviewConfirmMatch = url.pathname.match(/^\/api\/v1\/deal-reviews\/(review-[0-9a-f-]{36})\/confirm$/);
    const isConfirmReview = Boolean(reviewConfirmMatch) && request.method === "POST";
    const dealActionMatch = url.pathname.match(/^\/api\/v1\/deal-operations\/(op-[0-9a-f-]{36})\/(reconcile|repair)$/);
    const isDealAction = Boolean(dealActionMatch) && request.method === "POST";
    const isCatalogBuild = url.pathname === "/api/v1/catalog-builds" && request.method === "POST";
    const catalogBuildMatch = url.pathname.match(/^\/api\/v1\/catalog-builds\/(build-[a-f0-9]{24})$/);
    const isCatalogBuildRead = Boolean(catalogBuildMatch) && (request.method === "GET" || request.method === "HEAD");
    const builtParticipantsMatch = url.pathname.match(/^\/api\/v1\/catalog-builds\/(build-[a-f0-9]{24})\/participants(?:\/(co-[a-f0-9]{20}))?$/);
    const builtPreleadMatch = url.pathname.match(/^\/api\/v1\/catalog-builds\/(build-[a-f0-9]{24})\/participants\/(co-[a-f0-9]{20})\/prelead$/);
    const isBuiltPrelead = Boolean(builtPreleadMatch) && request.method === "POST";
    const catalogBuildPreviewMatch = url.pathname.match(/^\/api\/v1\/catalog-builds\/(build-[a-f0-9]{24})\/preview$/);
    const isCatalogBuildPreview = Boolean(catalogBuildPreviewMatch) && request.method === "POST";
    const catalogPreviewMatch = url.pathname.match(/^\/api\/v1\/catalog-previews\/(preview-[a-f0-9]{24})$/);
    const isCatalogPreviewRead = Boolean(catalogPreviewMatch) && (request.method === "GET" || request.method === "HEAD");
    if (request.method !== "GET" && request.method !== "HEAD" && !isCreateIntent && !isAppendPreleadEvent && !isConfirmDeal && !isPrepareReview && !isConfirmReview && !isDealAction && !isCatalogBuild && !isCatalogBuildPreview && !isBuiltPrelead) {
      response.setHeader("allow", "GET, HEAD, POST");
      return json(response, 405, { error: "method_not_allowed" });
    }
    if (url.pathname === "/api/v1/manifest") return json(response, 200, manifest);
    if (url.pathname === "/api/v1/readiness") {
      return json(response, 200, manifest.readiness);
    }
    if (url.pathname === "/api/v1/catalog") {
      const params = [...url.searchParams.keys()];
      const queryValues = url.searchParams.getAll("q");
      if (params.some((key) => key !== "q") || queryValues.length > 1 || (queryValues[0] && [...queryValues[0]].length > 120)) {
        return json(response, 400, { error: "invalid_query" });
      }
      const query = (queryValues[0] ?? "").trim().toLocaleLowerCase("en");
      const items = query
        ? catalog.filter((item) => `${item.name} ${item.city} ${item.country}`.toLocaleLowerCase("en").includes(query))
        : catalog;
      return json(response, 200, { domainApiVersion: manifest.domainApiVersion, items });
    }
    if (url.pathname === "/api/v1/companies" && (request.method === "GET" || request.method === "HEAD")) {
      if (url.searchParams.size > 0) return json(response, 400, { error: "invalid_query" });
      const context = await trustedProfile(request, response, "crm.companies.read");
      if (!context) return;
      const result = readExhibitionParticipants(context, dealIntents);
      return json(response, result.status, result.body);
    }
    const companyMatch = url.pathname.match(/^\/api\/v1\/companies\/(demo-company-[0-9]{3})$/);
    if (companyMatch && (request.method === "GET" || request.method === "HEAD")) {
      if (url.searchParams.size > 0) return json(response, 400, { error: "invalid_query" });
      const context = await trustedProfile(request, response, "crm.companies.read");
      if (!context) return;
      const participantResult = readExhibitionParticipants(context, dealIntents);
      if (participantResult.status !== 200) return json(response, participantResult.status, participantResult.body);
      const company = participantResult.body.items.find((item) => item.id === companyMatch[1]);
      return company
        ? json(response, 200, { domainApiVersion: manifest.domainApiVersion, company })
        : json(response, 404, { error: "company_not_found" });
    }
    if (isCreateIntent) {
      const context = await trustedProfile(request, response, "crm.deal_intents.prepare");
      if (!context) return;
      const idempotencyKey = request.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
        return json(response, 400, { error: "valid_idempotency_key_required" });
      }
      const parsed = await readJson(request);
      if (parsed.error) return json(response, parsed.error === "content_type_required" ? 415 : 400, { error: parsed.error });
      if (!isDealIntentRequest(parsed.value)) return json(response, 400, { error: "invalid_request" });
      const result = await dealIntents.create({ profileId: context.profileId, idempotencyKey, request: parsed.value });
      return json(response, result.status, result.body);
    }
    if (isConfirmDeal) {
      if (!allowUnsafeSyntheticConfirm) return json(response, 404, { error: "not_found" });
      const context = await trustedProfile(request, response, "crm.deals.confirm.synthetic");
      if (!context) return;
      const idempotencyKey = request.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) return json(response, 400, { error: "valid_idempotency_key_required" });
      const parsed = await readJson(request);
      if (parsed.error) return json(response, parsed.error === "content_type_required" ? 415 : 400, { error: parsed.error });
      const normalized = normalizeConfirmedDealRequest(parsed.value);
      if (!normalized) return json(response, 400, { error: "invalid_confirmed_deal_request", operationId: parsed.value?.operationId });
      const result = await dealService.create({ profileId: context.profileId, idempotencyKey, request: normalized });
      return json(response, result.status, result.body);
    }
    if (isPrepareReview) {
      const context = await trustedProfile(request, response, "crm.deals.review.synthetic");
      if (!context) return;
      const parsed = await readJson(request);
      if (parsed.error) return json(response, parsed.error === "content_type_required" ? 415 : 400, { error: parsed.error });
      const draft = normalizeDealReviewRequest(parsed.value);
      const result = await dealReviews.prepare({ profileId: context.profileId, request: draft ?? parsed.value });
      return json(response, result.status, result.body);
    }
    if (reviewMatch && (request.method === "GET" || request.method === "HEAD")) {
      const context = await trustedProfile(request, response, "crm.deals.review.synthetic");
      if (!context) return;
      const result = await dealReviews.get({ profileId: context.profileId, reviewId: reviewMatch[1] });
      return json(response, result.status, result.body);
    }
    if (isConfirmReview) {
      const context = await trustedProfile(request, response, "crm.deals.confirm.synthetic");
      if (!context) return;
      const parsed = await readJson(request);
      if (parsed.error) return json(response, parsed.error === "content_type_required" ? 415 : 400, { error: parsed.error });
      if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value) ||
          Object.keys(parsed.value).some((key) => key !== "revision") || typeof parsed.value.revision !== "string") {
        return json(response, 400, { error: "invalid_review_confirmation" });
      }
      let trustedReceipt;
      try { trustedReceipt = await resolveTrustedReviewReceipt?.(request, context); } catch {}
      const result = await dealReviews.confirm({ profileId: context.profileId, reviewId: reviewConfirmMatch[1], revision: parsed.value.revision, trustedReceipt });
      return json(response, result.status, result.body);
    }
    if (isDealAction) {
      const scope = dealActionMatch[2] === "repair" ? "crm.deals.links.repair.synthetic" : "crm.deals.operations.read.synthetic";
      const context = await trustedProfile(request, response, scope);
      if (!context) return;
      if (url.searchParams.size > 0) return json(response, 400, { error: "invalid_query" });
      const result = dealActionMatch[2] === "repair"
        ? await dealService.repair({ profileId: context.profileId, operationId: dealActionMatch[1] })
        : await dealService.reconcile({ profileId: context.profileId, operationId: dealActionMatch[1] });
      return json(response, result.status, result.body);
    }
    const operationMatch = url.pathname.match(/^\/api\/v1\/deal-operations\/(op-[0-9a-f-]{36})$/);
    if (operationMatch && (request.method === "GET" || request.method === "HEAD")) {
      const context = await trustedProfile(request, response, "crm.deals.operations.read.synthetic");
      if (!context) return;
      const result = dealService.get({ profileId: context.profileId, operationId: operationMatch[1] });
      return json(response, result.status, result.body);
    }
    if (isCatalogBuild) {
      const context = await trustedProfile(request, response, "crm.catalog.build.synthetic");
      if (!context) return;
      if (url.searchParams.size > 0) return json(response, 400, { error: "invalid_query", code: "BUILD_INVALID_QUERY" });
      const idempotencyKey = request.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) return json(response, 400, { error: "valid_idempotency_key_required", code: "BUILD_IDEMPOTENCY_KEY_REQUIRED" });
      const parsed = await readJson(request);
      if (parsed.error) return json(response, parsed.error === "content_type_required" ? 415 : 400, { error: parsed.error, code: "BUILD_INVALID_REQUEST" });
      if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value) || Object.keys(parsed.value).length !== 1 || typeof parsed.value.exhibitionId !== "string" || !/^demo-expo-[0-9]{3}$/.test(parsed.value.exhibitionId)) return json(response, 400, { error: "invalid_catalog_build_request", code: "BUILD_INVALID_REQUEST" });
      const result = await catalogBuilds.build({ profileId: context.profileId, idempotencyKey, exhibitionId: parsed.value.exhibitionId });
      return json(response, result.status, result.body);
    }
    if (isCatalogBuildPreview) {
      const context = await trustedProfile(request, response, "crm.catalog.preview.synthetic");
      if (!context) return;
      if (url.searchParams.size > 0) return json(response, 400, { error: "invalid_query", code: "PREVIEW_INVALID_QUERY" });
      const result = catalogBuilds.preview({ profileId: context.profileId, buildId: catalogBuildPreviewMatch[1] });
      return json(response, result.status, result.body);
    }
    if (isCatalogPreviewRead) {
      if (url.searchParams.size > 0) return json(response, 400, { error: "invalid_query", code: "PREVIEW_INVALID_QUERY" });
      const context = await trustedProfile(request, response, "crm.catalog.preview.read.synthetic");
      if (!context) return;
      const result = catalogBuilds.getPreview({ profileId: context.profileId, previewId: catalogPreviewMatch[1] });
      if (result.status !== 200) return json(response, result.status, result.body);
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
      });
      return response.end(result.html);
    }
    if (isCatalogBuildRead) {
      if (url.searchParams.size > 0) return json(response, 400, { error: "invalid_query", code: "BUILD_INVALID_QUERY" });
      const context = await trustedProfile(request, response, "crm.catalog.build.read.synthetic");
      if (!context) return;
      const result = catalogBuilds.get({ profileId: context.profileId, buildId: catalogBuildMatch[1] });
      return json(response, result.status, result.body);
    }
    if (builtParticipantsMatch && (request.method === "GET" || request.method === "HEAD")) {
      const context = await trustedProfile(request, response, "crm.catalog.build.read.synthetic");
      if (!context) return;
      const keys = [...url.searchParams.keys()];
      const queryValues = url.searchParams.getAll("q");
      const classValues = url.searchParams.getAll("classification");
      if (keys.some((key) => !["q", "classification"].includes(key)) || queryValues.length > 1 || classValues.length > 1 ||
          (queryValues[0] && [...queryValues[0]].length > 120) ||
          (classValues[0] && !["target", "near_target", "not_target", "unknown"].includes(classValues[0])) ||
          (builtParticipantsMatch[2] && keys.length > 0)) {
        return json(response, 400, { error: "invalid_query", code: "BUILD_INVALID_QUERY" });
      }
      const result = catalogBuilds.readParticipants({ profileId: context.profileId, buildId: builtParticipantsMatch[1],
        companyId: builtParticipantsMatch[2] ?? null, query: queryValues[0] ?? "", classification: classValues[0] ?? null });
      return json(response, result.status, result.body);
    }
    if (isBuiltPrelead) {
      const context = await trustedProfile(request, response, "crm.preleads.create.synthetic");
      if (!context) return;
      if (url.searchParams.size > 0) return json(response, 400, { error: "invalid_query" });
      const owned = catalogBuilds.get({ profileId: context.profileId, buildId: builtPreleadMatch[1] });
      if (owned.status !== 200) return json(response, owned.status, owned.body);
      const result = participantResolver.ensureBuiltPrelead({ profileId: context.profileId,
        exhibitionId: owned.body.artifact.exhibitionId, companyId: builtPreleadMatch[2], buildId: builtPreleadMatch[1] });
      return json(response, result.status, result.body);
    }
    const intentMatch = url.pathname.match(/^\/api\/v1\/deal-intents\/(demo-intent-[0-9a-f-]{36})$/);
    if (intentMatch && (request.method === "GET" || request.method === "HEAD")) {
      if (url.searchParams.size > 0) return json(response, 400, { error: "invalid_query" });
      const context = await trustedProfile(request, response, "crm.deal_intents.read");
      if (!context) return;
      const result = await dealIntents.get({ profileId: context.profileId, id: intentMatch[1] });
      return json(response, result.status, result.body);
    }
    const timelineMatch = url.pathname.match(/^\/api\/v1\/preleads\/((?:demo-prelead-[0-9]{3}|built-prelead-[a-f0-9]{24}))\/timeline$/);
    if (timelineMatch && (request.method === "GET" || request.method === "HEAD")) {
      if (url.searchParams.size > 0) return json(response, 400, { error: "invalid_query" });
      const context = await trustedProfile(request, response, "crm.preleads.read");
      if (!context) return;
      const result = preleadTimeline.getTimeline({ profileId: context.profileId, preleadId: timelineMatch[1] });
      return json(response, result.status, result.body);
    }
    if (isAppendPreleadEvent) {
      if (url.searchParams.size > 0) return json(response, 400, { error: "invalid_query" });
      const context = await trustedProfile(request, response, "crm.preleads.events.append");
      if (!context) return;
      const parsed = await readJson(request);
      if (parsed.error) return json(response, parsed.error === "content_type_required" ? 415 : 400, { error: parsed.error });
      const eventRequest = normalizePreleadEventRequest(parsed.value);
      if (!eventRequest) return json(response, 400, { error: "invalid_event_request" });
      const result = preleadTimeline.appendEvent({
        profileId: context.profileId,
        preleadId: timelineEventMatch[1],
        request: eventRequest
      });
      return json(response, result.status, result.body);
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = await readFile(new URL("../public/index.html", import.meta.url));
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return response.end(html);
    }
    return json(response, 404, { error: "not_found" });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 3000);
  createServer().listen(port, "127.0.0.1", () => {
    console.log(`crm-web listening on http://127.0.0.1:${port}`);
  });
}
