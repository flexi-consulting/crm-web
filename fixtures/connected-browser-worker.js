import { createCrmConnectedWorkerHandler } from "../src/connected-browser-worker.js";
import { createCatalogBuildService } from "../src/catalog-build.js";
import { createBuiltCatalogD1Repository } from "../src/built-catalog-d1.js";
import { createCatalogV11D1Repository, createCatalogV12D1Repository } from "../src/catalog-query-v11.js";
import { projectLegacyExSnapshot, projectLegacyExSnapshotV11, projectLegacyExSnapshotV12 } from "../src/legacy-ex-snapshot.js";

const issuer = "https://cp.example.invalid";
let crmDb;
let weeekDb;
let clockOffset = 0;
const fixtureState = async () => await crmDb.prepare("SELECT * FROM sandbox_cp_state WHERE id = 1").first();
const bump = async (column) => crmDb.prepare(`UPDATE sandbox_cp_state SET ${column} = ${column} + 1 WHERE id = 1`).run();
const setFixtureMode = async (mode) => {
  await crmDb.prepare("UPDATE sandbox_cp_state SET mode = ? WHERE id = 1").bind(mode).run();
  return fixtureState();
};
const cpFetch = async (url, options) => {
  if (url.startsWith("https://api.weeek.net/public/v1/")) {
    if (!weeekDb) throw new Error("synthetic_weeek_fixture_unavailable");
    if (options.headers?.Authorization !== "Bearer synthetic-weeek-token") throw new Error("synthetic_token_denied");
    const target = new URL(url), method = options.method ?? "GET";
    if (method === "POST" && /^\/public\/v1\/crm\/statuses\/status-lead-A\/deals$/.test(target.pathname)) {
      const body = JSON.parse(options.body);
      const existing = await weeekDb.prepare("SELECT COUNT(*) AS n FROM weeek_fixture_deals").first();
      const id = `weeek_deal_opaque_${String((existing?.n ?? 0) + 1).padStart(3, "0")}`;
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
  if (!url.startsWith(`${issuer}/v1/connected-app-sessions/`) &&
      !url.startsWith(`${issuer}/v1/connected-app-approvals/`) || options.redirect !== "manual") {
    await bump("foreign_egress");
    throw new Error("unexpected_egress");
  }
  await bump("cp_calls");
  let state = await fixtureState();
  if (state.mode === "outage") throw new Error("synthetic_cp_outage");
  const now = Math.floor(Date.now() / 1000);
  const approvalRoute = new URL(url).pathname;
  if (approvalRoute.endsWith("/prepare")) {
    await bump("approval_prepare_calls");
    state = await fixtureState();
    if (options.headers?.authorization !== "Bearer local-test-service-key-12345678901234567890")
      return Response.json({ error: "unauthorized" }, { status: 401 });
    const body = JSON.parse(options.body);
    if (body.audience !== "crm-web" || body.command !== "crm.deals.create" ||
        body.appToken !== "b".repeat(64) || !/^[a-f0-9]{64}$/.test(body.sourceRevision))
      return Response.json({ error: "invalid request" }, { status: 400 });
    const intentId = `${String(state.approval_prepare_calls).padStart(64, "0")}`;
    return Response.json({ version: 1, intentId,
      approvalUrl: `${issuer}/v1/connected-app-approvals/review?intent=${intentId}`, expiresAt: now + 600 }, { status: 201 });
  }
  if (approvalRoute.endsWith("/consume")) {
    await bump("approval_consume_calls");
    state = await fixtureState();
    if (options.headers?.authorization !== "Bearer local-test-service-key-12345678901234567890")
      return Response.json({ error: "unauthorized" }, { status: 401 });
    const body = JSON.parse(options.body);
    if (body.audience !== "crm-web" || body.command !== "crm.deals.create" ||
        body.appToken !== "b".repeat(64) || !/^op-[a-f0-9-]{36}$/.test(body.consumerRequestId) ||
        !/^[a-f0-9]{64}$/.test(body.sourceRevision))
      return Response.json({ error: "invalid request" }, { status: 400 });
    if (state.mode === "receipt_approved_response_lost" && state.lost_approval_json) {
      const lostApproval = JSON.parse(state.lost_approval_json);
      if (body.intentId === lostApproval.intentId && body.consumerRequestId === lostApproval.consumerRequestId)
        return Response.json(lostApproval.response, { status: 200 });
    }
    if (state.mode === "expired_unconsumed") return body.intentId === state.expired_intent_id
      ? Response.json({ error: "approval not available" }, { status: 403 })
      : Response.json({ error: "human approval required" }, { status: 403 });
    if (!["receipt_approved", "receipt_approved_response_lost"].includes(state.mode))
      return Response.json({ error: "human approval required" }, { status: 403 });
    const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
    const requestHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",
      new TextEncoder().encode(JSON.stringify({ audience: "crm-web", clientId: "crm-web",
        commandId: "crm.deals.create", operation: canonical(body.operation), sourceRevision: body.sourceRevision })))),
    (byte) => byte.toString(16).padStart(2, "0")).join("");
    const receiptId = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",
      new TextEncoder().encode(body.intentId))), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const response = { version: 1, receipt: { receiptId, audience: "crm-web",
      clientId: "crm-web", command: "crm.deals.create", requestHash, sourceRevision: body.sourceRevision,
      principalId: "principal_A", profileId: "profile_A", approvedAt: now - 5, consumedAt: now,
      operation: body.operation } };
    if (state.mode === "receipt_approved_response_lost") {
      await crmDb.prepare("UPDATE sandbox_cp_state SET lost_approval_json = ? WHERE id = 1")
        .bind(JSON.stringify({ intentId: body.intentId, consumerRequestId: body.consumerRequestId, response })).run();
      throw new Error("synthetic_cp_response_lost_after_consume");
    }
    return Response.json(response, { status: 201 });
  }
  if (url.endsWith("/exchange")) return new Response(JSON.stringify({ token: "b".repeat(64),
    expiresAt: now + 300 }), { status: 201 });
  state = await fixtureState();
  if (url.endsWith("/introspect")) return new Response(JSON.stringify(state.mode === "revoked"
    ? { active: false } : { active: true, iss: issuer, aud: "crm-web", sub: "principal_A",
      profileId: "profile_A", sessionId: "session_A", nbf: now - 10, exp: now + 300,
      scopes: state.mode === "catalog_only" ? ["crm.catalog.read"] :
        ["deal_create", "deal_create_no_approval", "deal_create_approved_fixture", "expired_unconsumed", "receipt_approved",
          "receipt_approved_response_lost"].includes(state.mode)
          ? ["crm.deals.create"] :
        state.mode === "deals_only" ? ["crm.deals.read"] :
          ["crm.catalog.read", "crm.deals.read"] }), { status: 200 });
  await bump("foreign_egress");
  throw new Error("unexpected_cp_path");
};
const connected = createCrmConnectedWorkerHandler({ fetcher: cpFetch,
  now: () => Date.now() + clockOffset,
  resolveWeeekToken: async (profileId) => profileId === "profile_A" ? "synthetic-weeek-token" : null,
  resolveWeeekStatusIds: async (profileId) => profileId === "profile_A" ? ["status-lead-A"] : [],
  resolveLeadStatusId: async (profileId) => profileId === "profile_A" ? "status-lead-A" : null });

// Fixture only: all public-shaped routes below call the real Worker composition.
export default {
  async fetch(request, env) {
    weeekDb = env.WEEEK_FIXTURE_DB;
    crmDb = env.CRM_DB;
    await crmDb.prepare(`CREATE TABLE IF NOT EXISTS sandbox_cp_state (
      id INTEGER PRIMARY KEY CHECK (id = 1), mode TEXT NOT NULL DEFAULT 'active',
      cp_calls INTEGER NOT NULL DEFAULT 0, foreign_egress INTEGER NOT NULL DEFAULT 0,
      approval_prepare_calls INTEGER NOT NULL DEFAULT 0, approval_consume_calls INTEGER NOT NULL DEFAULT 0,
      clock_offset INTEGER NOT NULL DEFAULT 0, expired_intent_id TEXT, lost_approval_json TEXT)`).run();
    await crmDb.prepare("INSERT OR IGNORE INTO sandbox_cp_state (id) VALUES (1)").run();
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname === "/__sandbox-login" && request.method === "GET") {
      let buildId = url.searchParams.get("build_id"), companyId = url.searchParams.get("company_id");
      if (!buildId && !companyId) {
        const generated = await createCatalogBuildService().build({ profileId: "profile_A",
          idempotencyKey: "connected-worker-seed", exhibitionId: "demo-expo-001" });
        const repo = createBuiltCatalogD1Repository(env.CRM_DB);
        const saved = await repo.saveBuild({ profileRef: "profile_A", idempotencyKey: "connected-worker-seed",
          build: generated.body });
        if (!["stored", "replay"].includes(saved.status))
          return Response.json({ error: "synthetic_catalog_unavailable" }, { status: 503 });
        const listing = await repo.readParticipants({ profileRef: "profile_A", buildId: saved.buildId });
        buildId = saved.buildId;
        companyId = listing.body?.items?.[0]?.id;
        if (companyId) await repo.ensurePrelead({ profileRef: "profile_A", buildId, companyId });
      }
      if (!/^build-[a-f0-9]{24}$/.test(buildId ?? "") || !/^co-[a-f0-9]{20}$/.test(companyId ?? ""))
        return Response.json({ error: "synthetic_catalog_required" }, { status: 400 });
      await setFixtureMode("deal_create");
      const returnPath = `/catalogs/${buildId}/participants/${companyId}/deal`;
      const start = await connected(new Request(`https://crm.example.invalid/auth/connected/start?${
        new URLSearchParams({ from: "dealCreate", returnTo: returnPath })}`), env);
      if (start.status !== 303) return Response.json({ error: "synthetic_login_unavailable" }, { status: 503 });
      const target = new URL(start.headers.get("location"));
      const pending = start.headers.getSetCookie().find((value) => value.startsWith("__Host-crm-connected-pending="))
        ?.split(";", 1)[0];
      const state = target.searchParams.get("state");
      if (!pending || !state) return Response.json({ error: "synthetic_login_unavailable" }, { status: 503 });
      const callback = await connected(new Request(`https://crm.example.invalid/auth/connected/callback?${
        new URLSearchParams({ code: "c".repeat(64), state, iss: issuer })}`, { headers: { cookie: pending } }), env);
      if (callback.status !== 303) return Response.json({ error: "synthetic_login_unavailable" }, { status: 503 });
      const session = callback.headers.getSetCookie().find((value) => value.startsWith("__Host-crm-connected-session="));
      if (!session) return Response.json({ error: "synthetic_login_unavailable" }, { status: 503 });
      return new Response(null, { status: 303, headers: { location: returnPath, "set-cookie": session,
        "cache-control": "no-store", "x-robots-tag": "noindex" } });
    }
    if (url.pathname === "/__sandbox-approve") {
      await setFixtureMode("receipt_approved");
      return new Response("<!doctype html><meta charset=utf-8><title>Synthetic Control Plane</title><h1>Synthetic approval granted</h1><p>This local test stub approved only the seeded demo operation.</p><a href='/'>Return to CRM</a>",
        { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
    }
    if (url.pathname === "/__seed") {
      const generated = await createCatalogBuildService().build({ profileId: "profile_A",
        idempotencyKey: "connected-worker-seed", exhibitionId: "demo-expo-001" });
      const saved = await createBuiltCatalogD1Repository(env.CRM_DB, () => new Date().toISOString())
        .saveBuild({ profileRef: "profile_A", idempotencyKey: "connected-worker-seed", build: generated.body });
      const repo = createBuiltCatalogD1Repository(env.CRM_DB, () => new Date().toISOString());
      const listing = await repo.readParticipants({ profileRef: "profile_A", buildId: saved.buildId });
      const item = listing.body.items[0];
      await repo.ensurePrelead({ profileRef: "profile_A", buildId: saved.buildId, companyId: item.id });
      const exhibitionId = "synthetic-current-source-shape";
      const sourceRows = [{ id: "SYNTH001", n: "Synthetic manufacturing", s: "S-01", t: 1, nt: 0,
        inn: "0000000001", ogrn: null, ru: 1, country: "Sample Federation",
        cat: "Synthetic manufacturing", b: "Synthetic source description", seg: "Synthetic segment",
        rev: 250, ry: 2025, prof: 0, py: 2024, href: "https://example.invalid/synthetic-exhibitor",
        dir: "Synthetic Director 001", dirpos: "Synthetic director role",
        taxesPaidRub: 1250000, taxesPaidYear: 2024, taxesPaidProvider: "synthetic-registry",
        employeeCount: 42, employeeYear: 2025, employeeDefinition: "year_end",
        employeeCountProvider: "synthetic-registry" }];
      const legacyV1 = projectLegacyExSnapshot({ profileRef: "profile_A", eventKey: exhibitionId, entries: sourceRows });
      const legacyV11 = projectLegacyExSnapshotV11({ profileRef: "profile_A", eventKey: exhibitionId, entries: sourceRows });
      const legacyV12 = projectLegacyExSnapshotV12({ profileRef: "profile_A", eventKey: exhibitionId, entries: sourceRows });
      if (legacyV1.status !== "projected" || legacyV11.status !== "projected" || legacyV12.status !== "projected")
        throw new Error("synthetic legacy catalog projection failed");
      const linkedBuild = await repo.saveBuild({ profileRef: "profile_A", idempotencyKey: legacyV1.idempotencyKey,
        build: legacyV1.build, legacyRefs: legacyV1.legacyRefs });
      if (!["stored", "replay"].includes(linkedBuild.status)) throw new Error(`v1.0 linked seed failed: ${linkedBuild.status}`);
      await repo.ensurePrelead({ profileRef: "profile_A", buildId: linkedBuild.buildId,
        companyId: legacyV1.legacyRefs[0].companyId });
      const v11 = createCatalogV11D1Repository(env.CRM_DB);
      const v11Saved = await v11.saveArtifact({ profileId: "profile_A", artifact: legacyV11.artifact });
      if (!["stored", "replay"].includes(v11Saved.status)) throw new Error(`v11 seed failed: ${v11Saved.status}`);
      const v12 = createCatalogV12D1Repository(env.CRM_DB);
      const v12Saved = await v12.saveArtifact({ profileId: "profile_A", artifact: legacyV12.artifact });
      if (!["stored", "replay"].includes(v12Saved.status)) throw new Error(`v12 seed failed: ${v12Saved.status}`);
      return Response.json({ buildId: saved.buildId, companyId: item.id,
        v11ExhibitionId: exhibitionId,
        v12CompanyId: legacyV12.artifact.companies[0].id,
        v11CompanyId: legacyV1.legacyRefs[0].companyId,
        exhibitionId: "demo-expo-001", companyName: item.name });
    }
    if (url.pathname === "/__cp-control") {
      const state = await setFixtureMode(url.searchParams.get("mode") ?? "active");
      return Response.json({ cpMode: state.mode, cpCalls: state.cp_calls, foreignEgress: state.foreign_egress });
    }
    if (url.pathname === "/__cp-count") {
      const count = await weeekDb.prepare("SELECT COUNT(*) AS n FROM weeek_fixture_calls WHERE method = 'POST'").first();
      const state = await fixtureState();
      return Response.json({ cpCalls: state.cp_calls, foreignEgress: state.foreign_egress,
        approvalPrepareCalls: state.approval_prepare_calls, approvalConsumeCalls: state.approval_consume_calls,
        weeekCreatePosts: count?.n ?? 0 });
    }
    if (url.pathname === "/__browser-storage") {
      const pending = await env.CRM_DB.prepare(`SELECT handle_hash, sealed_payload, return_path, mode,
        created_at_ms, expires_at_ms FROM connected_browser_pending`).all();
      const sessions = await env.CRM_DB.prepare(`SELECT handle_hash, sealed_payload, created_at_ms,
        expires_at_ms FROM connected_browser_sessions`).all();
      return Response.json({ pending: pending.results ?? [], sessions: sessions.results ?? [] });
    }
    if (url.pathname === "/__missing-encryption-key") {
      const withoutEncryptionKey = { ...env, CRM_CONNECTED_BFF_ENCRYPTION_KEY: undefined };
      return connected(new Request("https://crm.example.invalid/catalogs/build-aaaaaaaaaaaaaaaaaaaaaaaa", request),
        withoutEncryptionKey);
    }
    if (url.pathname === "/__clock-offset") {
      clockOffset = Number(url.searchParams.get("milliseconds") ?? 0);
      return Response.json({ clockOffset });
    }
    if (url.pathname === "/__expire-approval") {
      const current = await env.CRM_DB.prepare("SELECT intent_id FROM crm_cp_approval_intents WHERE profile_ref=?")
        .bind("profile_A").first();
      await crmDb.prepare("UPDATE sandbox_cp_state SET expired_intent_id = ? WHERE id = 1")
        .bind(current?.intent_id ?? null).run();
      await env.CRM_DB.prepare("UPDATE crm_cp_approval_intents SET expires_at=? WHERE profile_ref=?")
        .bind(Math.floor(Date.now() / 1000) - 1, "profile_A").run();
      return Response.json({ expired: true });
    }
    return connected(new Request(`https://crm.example.invalid${url.pathname}${url.search}`, request), env);
  }
};
