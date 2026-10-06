import test from "node:test";
import assert from "node:assert/strict";
import { createCrmConnectedBrowserHandler, createCrmControlPlaneClient,
  createMemoryCrmBrowserStore } from "../src/connected-browser-bff.js";

const issuer = "https://cp.example.invalid";
const origin = "https://crm.example.invalid";
const callback = `${origin}/auth/connected/callback`;
const build = `build-${"a".repeat(24)}`;
const token = "b".repeat(64);
const code = "c".repeat(64);
const now = 1_780_739_200_000;
const cookie = (response, name) => response.headers.getSetCookie()
  .map((value) => value.split(";")[0]).find((value) => value.startsWith(`${name}=`));
const request = (path, options = {}) => new Request(`${origin}${path}`, {
  method: options.method ?? "GET", headers: options.headers ?? {}
});

function fixture() {
  const store = createMemoryCrmBrowserStore();
  const calls = [];
  let selected = "profile_A", available = true, scopes = ["crm.catalog.read", "crm.deals.read"];
  const introspect = async ({ token: received, audience }) => {
    calls.push(["introspect", received, audience]);
    if (!available) throw new Error("unavailable");
    if (selected !== "profile_A") return { active: false };
    return { active: true, iss: issuer, aud: "crm-web", sub: "principal_A",
      profileId: selected, sessionId: "session_A", nbf: Math.floor(now / 1000) - 10,
      exp: Math.floor(now / 1000) + 300, scopes };
  };
  const handler = createCrmConnectedBrowserHandler({ enabled: true, issuer,
    allowedIssuerOrigins: [issuer], publicOrigin: origin, redirectUri: callback,
    defaultReturnPath: `/catalogs/${build}`, store,
    now: () => now, introspect, exchangeCode: async (args) => {
      calls.push(["exchange", args]);
      return { token, expiresAt: Math.floor(now / 1000) + 300 };
    },
    handleScopedRequest: async (received, identity) => {
      calls.push(["domain", received, identity]);
      return new Response(JSON.stringify({ profileId: identity.profileId, scopes: identity.scopes }),
        { headers: { "content-type": "application/json" } });
    } });
  return { handler, calls, setSelected: (value) => { selected = value; },
    setScopes: (value) => { scopes = value; },
    setAvailable: (value) => { available = value; } };
}

async function signIn(f, mode = "catalog", returnTo) {
  const params = new URLSearchParams({ from: mode });
  if (returnTo) params.set("returnTo", returnTo);
  const start = await f.handler(request(`/auth/connected/start?${params}`));
  assert.equal(start.status, 303);
  const target = new URL(start.headers.get("location"));
  assert.equal(target.origin, issuer);
  assert.equal(target.searchParams.get("client_id"), "crm-web");
  assert.equal(target.searchParams.get("redirect_uri"), callback);
  assert.equal(target.searchParams.get("code_challenge_method"), "S256");
  assert.equal(target.searchParams.get("code_challenge")?.length, 43);
  assert.equal(target.searchParams.get("scope"), mode === "catalog" ? "crm.catalog.read" : "crm.deals.read");
  const pending = cookie(start, "__Host-crm-connected-pending");
  const path = `/auth/connected/callback?code=${code}&state=${target.searchParams.get("state")}&iss=${encodeURIComponent(issuer)}`;
  const callbackResponse = await f.handler(request(path, { headers: { cookie: pending } }));
  assert.equal(callbackResponse.status, 303);
  assert.equal(callbackResponse.headers.get("location"), `${origin}${returnTo ?? (mode === "catalog" ? `/catalogs/${build}` : "/deals")}`);
  const session = cookie(callbackResponse, "__Host-crm-connected-session");
  assert.ok(session);
  assert.match(session, /^__Host-crm-connected-session=[a-f0-9]{64}$/);
  return { session, pending, path };
}

test("browser uses one-time code, fixed redirect and real profile read boundary", async () => {
  const f = fixture();
  const { session, pending, path } = await signIn(f);
  const replay = await f.handler(request(path, { headers: { cookie: pending } }));
  assert.equal(replay.status, 401);
  assert.equal(f.calls.filter(([kind]) => kind === "exchange").length, 1);
  const read = await f.handler(request(`/catalogs/${build}`, { headers: { cookie: session } }));
  assert.equal(read.status, 200);
  const body = await read.json();
  assert.equal(body.profileId, "profile_A");
  assert.deepEqual(body.scopes, ["crm.catalog.build.read.synthetic", "crm.deals.review.synthetic",
    "crm.deals.operations.read.synthetic"]);
  assert.equal(f.calls.filter(([kind]) => kind === "introspect").length, 2);
  assert.equal(f.calls.filter(([kind]) => kind === "domain").length, 1);
});

test("switch and CP outage deny browser reads without stale grant", async () => {
  const f = fixture();
  const { session } = await signIn(f);
  f.setSelected("profile_B");
  assert.equal((await f.handler(request(`/catalogs/${build}`, { headers: { cookie: session } }))).status, 401);
  f.setSelected("profile_A");
  f.setAvailable(false);
  assert.equal((await f.handler(request(`/catalogs/${build}`, { headers: { cookie: session } }))).status, 503);
  assert.equal(f.calls.filter(([kind]) => kind === "domain").length, 0);
});

test("browser cannot supply bearer/profile or send deal mutation through read boundary", async () => {
  const f = fixture();
  const { session } = await signIn(f);
  assert.equal((await f.handler(request(`/catalogs/${build}?profileId=profile_B`,
    { headers: { cookie: session } }))).status, 400);
  assert.equal((await f.handler(request(`/catalogs/${build}`,
    { headers: { cookie: session, authorization: `Bearer ${token}` } }))).status, 400);
  assert.equal((await f.handler(request(`/api/v1/deal-reviews/${`review-${"d".repeat(36)}`}/confirm`,
    { method: "POST", headers: { cookie: session } }))).status, 404);
  assert.equal(f.calls.filter(([kind]) => kind === "domain").length, 0);
});

test("logout needs same-origin CSRF token and remains available when introspection fails", async () => {
  const f = fixture();
  const { session } = await signIn(f);
  const metadata = await f.handler(request("/auth/connected/session", { headers: { cookie: session } }));
  assert.equal(metadata.status, 200);
  const csrf = (await metadata.json()).csrfToken;
  assert.match(csrf, /^[a-f0-9]{64}$/);
  assert.equal((await f.handler(request("/auth/connected/logout", { method: "POST",
    headers: { cookie: session, origin } }))).status, 403);
  f.setAvailable(false);
  assert.equal((await f.handler(request("/auth/connected/session", { headers: { cookie: session } }))).status, 503);
  assert.equal((await f.handler(request("/auth/connected/logout", { method: "POST",
    headers: { cookie: session, origin, "x-csrf-token": csrf } }))).status, 204);
  assert.equal((await f.handler(request(`/catalogs/${build}`, { headers: { cookie: session } }))).status, 401);
});

test("configuration and CP transport refuse redirects and arbitrary origins", async () => {
  assert.throws(() => createCrmConnectedBrowserHandler({ enabled: true, issuer,
    allowedIssuerOrigins: ["https://other.example.invalid"], publicOrigin: origin }),
  /connected_browser_ports_required/);
  const requests = [];
  const client = createCrmControlPlaneClient({ issuer, allowedIssuerOrigins: [issuer], serviceKey: "k".repeat(32),
    fetcher: async (url, options) => { requests.push([url, options]);
      return new Response(JSON.stringify({ active: false }), { status: 200 }); } });
  await client.introspect({ token, audience: "crm-web" });
  assert.equal(requests[0][0], `${issuer}/v1/connected-app-sessions/introspect`);
  assert.equal(requests[0][1].redirect, "manual");
  assert.deepEqual(JSON.parse(requests[0][1].body), { token, audience: "crm-web" });
});

test("callback rejects wrong issuer and consumes the pending transaction", async () => {
  const f = fixture();
  const start = await f.handler(request("/auth/connected/start?from=catalog"));
  const target = new URL(start.headers.get("location"));
  const pending = cookie(start, "__Host-crm-connected-pending");
  const wrong = `/auth/connected/callback?code=${code}&state=${target.searchParams.get("state")}` +
    `&iss=${encodeURIComponent("https://other.example.invalid")}`;
  assert.equal((await f.handler(request(wrong, { headers: { cookie: pending } }))).status, 401);
  const correct = wrong.replace(encodeURIComponent("https://other.example.invalid"), encodeURIComponent(issuer));
  assert.equal((await f.handler(request(correct, { headers: { cookie: pending } }))).status, 401);
  assert.equal(f.calls.filter(([kind]) => kind === "exchange").length, 0);
});

test("neutral entry and separate catalog/deal grants preserve an earlier session on denial", async () => {
  const f = fixture();
  const chooser = await f.handler(request("/auth/connected/start"));
  assert.equal(chooser.status, 200);
  assert.match(await chooser.text(), /from=catalog.*from=deals/);
  f.setScopes(["crm.catalog.read"]);
  const { session } = await signIn(f);
  assert.equal((await f.handler(request(`/catalogs/${build}`, { headers: { cookie: session } }))).status, 200);
  const denied = await f.handler(request("/auth/connected/start?from=deals"));
  const target = new URL(denied.headers.get("location"));
  const pending = cookie(denied, "__Host-crm-connected-pending");
  const callback = await f.handler(request(`/auth/connected/callback?code=${code}&state=${target.searchParams.get("state")}` +
    `&iss=${encodeURIComponent(issuer)}`, { headers: { cookie: `${pending}; ${session}` } }));
  assert.equal(callback.status, 401);
  assert.equal((await f.handler(request(`/catalogs/${build}`, { headers: { cookie: session } }))).status, 200);
  f.setScopes(["crm.deals.read"]);
  const deal = await signIn(f, "deals");
  assert.equal((await f.handler(request("/deals", { headers: { cookie: deal.session } }))).status, 200);
  assert.equal((await f.handler(request(`/catalogs/${build}`, { headers: { cookie: deal.session } }))).status, 403);
  assert.equal((await f.handler(request("/auth/connected/start?from=deals&returnTo=%2F%2Fevil.invalid"))).status, 400);
  assert.equal((await f.handler(request("/auth/connected/start?from=catalog&returnTo=%2Fdeals"))).status, 400);
});
