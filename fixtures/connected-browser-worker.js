import { createCrmConnectedWorkerHandler } from "../src/connected-browser-worker.js";
import { createCatalogBuildService } from "../src/catalog-build.js";
import { createBuiltCatalogD1Repository } from "../src/built-catalog-d1.js";

const issuer = "https://cp.example.invalid";
let cpMode = "active", cpCalls = 0, foreignEgress = 0, clockOffset = 0;
const cpFetch = async (url, options) => {
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
        cpMode === "deals_only" ? ["crm.deals.read"] :
          ["crm.catalog.read", "crm.deals.read"] }), { status: 200 });
  foreignEgress++;
  throw new Error("unexpected_cp_path");
};
const connected = createCrmConnectedWorkerHandler({ fetcher: cpFetch,
  now: () => Date.now() + clockOffset });

// Fixture only: all public-shaped routes below call the real Worker composition.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname === "/__seed") {
      const generated = await createCatalogBuildService().build({ profileId: "profile_A",
        idempotencyKey: "connected-worker-seed", exhibitionId: "demo-expo-001" });
      const saved = await createBuiltCatalogD1Repository(env.CRM_DB, () => new Date().toISOString())
        .saveBuild({ profileRef: "profile_A", idempotencyKey: "connected-worker-seed", build: generated.body });
      return Response.json({ buildId: saved.buildId });
    }
    if (url.pathname === "/__cp-control") {
      cpMode = url.searchParams.get("mode") ?? "active";
      return Response.json({ cpMode, cpCalls, foreignEgress });
    }
    if (url.pathname === "/__cp-count") return Response.json({ cpCalls, foreignEgress });
    if (url.pathname === "/__clock-offset") {
      clockOffset = Number(url.searchParams.get("milliseconds") ?? 0);
      return Response.json({ clockOffset });
    }
    return connected(new Request(`https://crm.example.invalid${url.pathname}${url.search}`, request), env);
  }
};
