import { createBuiltCatalogD1Domain, createBuiltCatalogD1HttpHandler } from "../src/built-catalog-d1-http.js";
import { createBuiltD1OfflineMcp } from "../src/built-d1-offline-mcp.js";
import { importLegacyExSnapshot } from "../src/legacy-ex-snapshot.js";

let providerCalls = 0;
const now = "2026-10-06T09:00:00.000Z";
const scopes = ["crm.catalog.build.synthetic", "crm.catalog.build.read.synthetic", "crm.preleads.create.synthetic",
  "crm.preleads.events.append", "crm.preleads.read", "crm.deals.review.synthetic",
  "crm.deals.confirm.synthetic", "crm.deals.operations.read.synthetic", "crm.deals.links.repair.synthetic"];
const context = (request) => ({ profileId: request.headers.get("x-test-profile") ?? "demo-profile-a",
  scopes: request.headers.get("x-test-scopes")?.split(",") ?? scopes });
const trustedReceipt = (request, profileId, reviewId, revision) => request.headers.get("x-test-approval") === "approved"
  ? { profileId, reviewId, revision, actorId: "synthetic-actor", issuerId: "local-http-test",
    receiptId: `receipt-${reviewId.slice(7)}`, approved: true,
    issuedAt: now, expiresAt: "2027-01-01T00:00:00.000Z" } : undefined;
const provider = { async create({ operationId, request: deal }) {
  providerCalls++;
  if (deal.title === "Unknown HTTP outcome") throw new Error("synthetic_timeout_after_reservation");
  return { status: "created", dealId: `demo-deal-${operationId.slice(3)}` };
} };
const respond = (status, body) => new Response(JSON.stringify(body), { status,
  headers: { "content-type": "application/json" } });

// Local fixture only. The test headers are never a production identity or approval source.
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/health") return respond(200, { ok: true });
    if (path === "/__provider-count") return respond(200, { calls: providerCalls });
    if (path === "/__import-legacy-fixture") {
      if (request.method !== "POST") return respond(405, { error: "method_not_allowed" });
      let args;
      try { args = await request.json(); } catch { return respond(400, { error: "invalid_json" }); }
      const domain = createBuiltCatalogD1Domain({ db: env.CRM_DB, provider, now: () => now });
      const result = await importLegacyExSnapshot({ repository: domain.catalogBuilds,
        profileRef: context(request).profileId, eventKey: args.eventKey, entries: args.entries });
      return respond(result.status === "stored" ? 201 : result.status === "replay" ? 200 : 422, result);
    }
    if (path === "/__offline-mcp") {
      let args;
      try { args = await request.json(); } catch { return respond(400, { error: "invalid_json" }); }
      const domain = createBuiltCatalogD1Domain({ db: env.CRM_DB, provider, now: () => now });
      const resolveTrustedProfile = () => context(request);
      const mcp = createBuiltD1OfflineMcp({ domain, resolveTrustedProfile,
        resolveTrustedReviewReceipt: ({ profileId, reviewId, revision }) =>
          trustedReceipt(request, profileId, reviewId, revision) });
      const initialized = JSON.parse(await mcp.receive({ jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: args.protocolVersion ?? "2025-06-18" } }));
      if (initialized.error) return respond(200, initialized);
      await mcp.receive({ jsonrpc: "2.0", method: "notifications/initialized" });
      if (args.method === "tools/list") return respond(200, JSON.parse(await mcp.receive({ jsonrpc: "2.0",
        id: 2, method: "tools/list", params: {} })));
      const name = args.name ?? (args.contract === "s01" ? "crm_built_catalog_participants_read" : null);
      return respond(200, JSON.parse(await mcp.receive({ jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name, arguments: args.arguments, _meta: { capabilityVersion: args.capabilityVersion ??
          (name === "crm_built_catalog_participants_read" || name?.startsWith("crm_built_prelead_") ? "1.1.0" : "1.0.0") } } })));
    }
    const handler = createBuiltCatalogD1HttpHandler({ db: env.CRM_DB,
      enabled: env.D1_CONNECTED_APP_ENABLED === "true" && request.headers.get("x-test-disable") !== "true",
      provider, now: () => now, resolveTrustedProfile: context,
      resolveTrustedReviewReceipt: (received, principal, reviewId, revision) =>
        trustedReceipt(received, principal.profileId, reviewId, revision) });
    return handler(request);
  }
};
