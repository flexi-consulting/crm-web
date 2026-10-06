import { createCrmConnectedWorkerHandler } from "../src/connected-browser-worker.js";
import { createCatalogBuildService } from "../src/catalog-build.js";
import { createBuiltCatalogD1Repository } from "../src/built-catalog-d1.js";

const issuer = "https://cp.example.invalid";
let cpMode = "active", cpCalls = 0, foreignEgress = 0, clockOffset = 0;
let weeekDb;
const cpFetch = async (url, options) => {
  if (url.startsWith("https://api.weeek.net/public/v1/")) {
    if (!weeekDb) throw new Error("synthetic_weeek_fixture_unavailable");
    if (options.headers?.Authorization !== "Bearer synthetic-weeek-token") throw new Error("synthetic_token_denied");
    const target = new URL(url), method = options.method ?? "GET";
    if (method === "POST" && /^\/public\/v1\/crm\/statuses\/status-lead-A\/deals$/.test(target.pathname)) {
      const body = JSON.parse(options.body);
      const id = "weeek_deal_opaque_001";
      await weeekDb.batch([
        weeekDb.prepare("INSERT INTO weeek_fixture_calls(method, path) VALUES (?, ?)").bind(method, target.pathname),
        weeekDb.prepare(`INSERT INTO weeek_fixture_deals(id, status_id, title, description)
          VALUES (?, ?, ?, ?)`).bind(id, "status-lead-A", body.title, body.description)
      ]);
      // Simulate the provider accepting the create, then losing its response.
      throw new Error("synthetic_timeout_after_provider_accept");
    }
    if (method === "GET" && target.pathname === "/public/v1/crm/statuses/status-lead-A/deals") {
      await weeekDb.prepare("INSERT INTO weeek_fixture_calls(method, path) VALUES (?, ?)").bind(method, target.pathname).run();
      const { results: rows } = await weeekDb.prepare(`SELECT id, status_id, title, description
        FROM weeek_fixture_deals WHERE status_id = ? ORDER BY id`).bind("status-lead-A").all();
      const all = (rows ?? []).map((row) => ({ id: row.id, statusId: row.status_id,
        title: row.title, description: row.description }));
      return Response.json({ success: true, deals: all, hasMoreDeals: false });
    }
    const detail = target.pathname.match(/^\/public\/v1\/crm\/deals\/([^/]+)$/);
    if (method === "GET" && detail) {
      await weeekDb.prepare("INSERT INTO weeek_fixture_calls(method, path) VALUES (?, ?)").bind(method, target.pathname).run();
      const row = await weeekDb.prepare(`SELECT id, status_id, title, description FROM weeek_fixture_deals WHERE id = ?`)
        .bind(decodeURIComponent(detail[1])).first();
      return Response.json({ success: true, deal: row ? { id: row.id, statusId: row.status_id,
        title: row.title, description: row.description } : null });
    }
    throw new Error("unexpected_weeek_path");
  }
  if (!url.startsWith(`${issuer}/v1/connected-app-sessions/`) || options.redirect !== "manual") {
    foreignEgress++;
    throw new Error("unexpected_egress");
  }
  cpCalls++;
  if (cpMode === "outage") throw new Error("synthetic_cp_outage");
  const now = Math.floor(Date.now() / 1000);
  if (url.endsWith("/exchange")) return new Response(JSON.stringify({ token: "b".repeat(64),
    expiresAt: now + 300 }), { status: 201 });
  if (url.endsWith("/introspect")) return new Response(JSON.stringify(cpMode === "revoked"
    ? { active: false } : { active: true, iss: issuer, aud: "crm-web", sub: "principal_A",
      profileId: "profile_A", sessionId: "session_A", nbf: now - 10, exp: now + 300,
      scopes: cpMode === "catalog_only" ? ["crm.catalog.read"] :
        ["deal_create", "deal_create_no_approval", "deal_create_approved_fixture"].includes(cpMode)
          ? ["crm.deals.create"] :
        cpMode === "deals_only" ? ["crm.deals.read"] :
          ["crm.catalog.read", "crm.deals.read"] }), { status: 200 });
  foreignEgress++;
  throw new Error("unexpected_cp_path");
};
const connected = createCrmConnectedWorkerHandler({ fetcher: cpFetch,
  now: () => Date.now() + clockOffset,
  // Only this isolated fixture can issue an approval receipt. Production
  // composition has no receipt issuer and therefore fails closed.
  resolveTrustedReviewReceipt: async ({ identity, reviewId, revision }) => {
    if (cpMode !== "deal_create_approved_fixture") return null;
    const issuedAt = new Date(Date.now() + clockOffset).toISOString();
    return { profileId: identity.profileId, reviewId, revision, actorId: identity.principalId,
      issuerId: "synthetic-test-approval-issuer",
      receiptId: `fixture-approval-${reviewId}-${revision}`, approved: true,
      issuedAt, expiresAt: new Date(Date.parse(issuedAt) + 60_000).toISOString() };
  },
  resolveWeeekToken: async (profileId) => profileId === "profile_A" ? "synthetic-weeek-token" : null,
  resolveWeeekStatusIds: async (profileId) => profileId === "profile_A" ? ["status-lead-A"] : [],
  resolveLeadStatusId: async (profileId) => profileId === "profile_A" ? "status-lead-A" : null });

// Fixture only: all public-shaped routes below call the real Worker composition.
export default {
  async fetch(request, env) {
    weeekDb = env.WEEEK_FIXTURE_DB;
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname === "/__seed") {
      const generated = await createCatalogBuildService().build({ profileId: "profile_A",
        idempotencyKey: "connected-worker-seed", exhibitionId: "demo-expo-001" });
      const saved = await createBuiltCatalogD1Repository(env.CRM_DB, () => new Date().toISOString())
        .saveBuild({ profileRef: "profile_A", idempotencyKey: "connected-worker-seed", build: generated.body });
      const repo = createBuiltCatalogD1Repository(env.CRM_DB, () => new Date().toISOString());
      const listing = await repo.readParticipants({ profileRef: "profile_A", buildId: saved.buildId });
      const item = listing.body.items[0];
      await repo.ensurePrelead({ profileRef: "profile_A", buildId: saved.buildId, companyId: item.id });
      return Response.json({ buildId: saved.buildId, companyId: item.id,
        exhibitionId: "demo-expo-001", companyName: item.name });
    }
    if (url.pathname === "/__cp-control") {
      cpMode = url.searchParams.get("mode") ?? "active";
      return Response.json({ cpMode, cpCalls, foreignEgress });
    }
    if (url.pathname === "/__cp-count") {
      const count = await weeekDb.prepare("SELECT COUNT(*) AS n FROM weeek_fixture_calls WHERE method = 'POST'").first();
      return Response.json({ cpCalls, foreignEgress, weeekCreatePosts: count?.n ?? 0 });
    }
    if (url.pathname === "/__clock-offset") {
      clockOffset = Number(url.searchParams.get("milliseconds") ?? 0);
      return Response.json({ clockOffset });
    }
    return connected(new Request(`https://crm.example.invalid${url.pathname}${url.search}`, request), env);
  }
};
