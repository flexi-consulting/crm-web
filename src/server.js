import { createServer as nodeCreateServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { catalog } from "./fixtures.js";
import { createDealIntentService, isDealIntentRequest } from "./deal-intents.js";
import { createPreleadTimelineService, normalizePreleadEventRequest } from "./prelead-timeline.js";

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
  dealIntents = createDealIntentService(),
  preleadTimeline = createPreleadTimelineService()
} = {}) {
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
    const timelineEventMatch = url.pathname.match(/^\/api\/v1\/preleads\/(demo-prelead-[0-9]{3})\/events$/);
    const isAppendPreleadEvent = Boolean(timelineEventMatch) && request.method === "POST";
    if (request.method !== "GET" && request.method !== "HEAD" && !isCreateIntent && !isAppendPreleadEvent) {
      response.setHeader("allow", "GET, HEAD");
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
      return json(response, 200, { domainApiVersion: manifest.domainApiVersion, items: dealIntents.visibleCompanies(context.profileId) });
    }
    const companyMatch = url.pathname.match(/^\/api\/v1\/companies\/(demo-company-[0-9]{3})$/);
    if (companyMatch && (request.method === "GET" || request.method === "HEAD")) {
      if (url.searchParams.size > 0) return json(response, 400, { error: "invalid_query" });
      const context = await trustedProfile(request, response, "crm.companies.read");
      if (!context) return;
      const company = dealIntents.visibleCompanies(context.profileId).find((item) => item.id === companyMatch[1]);
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
    const intentMatch = url.pathname.match(/^\/api\/v1\/deal-intents\/(demo-intent-[0-9a-f-]{36})$/);
    if (intentMatch && (request.method === "GET" || request.method === "HEAD")) {
      if (url.searchParams.size > 0) return json(response, 400, { error: "invalid_query" });
      const context = await trustedProfile(request, response, "crm.deal_intents.read");
      if (!context) return;
      const result = await dealIntents.get({ profileId: context.profileId, id: intentMatch[1] });
      return json(response, result.status, result.body);
    }
    const timelineMatch = url.pathname.match(/^\/api\/v1\/preleads\/(demo-prelead-[0-9]{3})\/timeline$/);
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
