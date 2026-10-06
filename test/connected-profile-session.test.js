import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createConnectedCrmReadBoundary, createConnectedCrmD1ReadHandler } from "../src/connected-profile-session.js";

const issuer = "https://agent.example.invalid";
const now = 1_780_739_200;
const buildId = `build-${"a".repeat(24)}`;
const companyId = `co-${"b".repeat(20)}`;
const reviewId = `review-${"c".repeat(36)}`;
const operationId = `op-${"d".repeat(36)}`;
const bearer = "Bearer invented-opaque-token-0001";
const contractRaw = readFileSync(new URL("../contracts/connected-app-identity-v1/contract.json", import.meta.url));
const schemaRaw = readFileSync(new URL("../contracts/connected-app-identity-v1/response.schema.json", import.meta.url));
const source = JSON.parse(readFileSync(new URL("../contracts/connected-app-identity-v1/source.json", import.meta.url)));
const contract = JSON.parse(contractRaw);
const schema = JSON.parse(schemaRaw);
const request = (path, options = {}) => new Request(`https://crm.example.invalid${path}`, {
  method: options.method ?? "GET", headers: { authorization: options.authorization ?? bearer,
    ...(options.cookie ? { cookie: options.cookie } : {}) }
});
const response = async (handler, path, options) => {
  const result = await handler(request(path, options));
  return { status: result.status, body: await result.json() };
};
function fixture() {
  const sessions = new Map([
    ["invented-opaque-token-0001", { principal: "person_A", profile: "profile_A",
      selected: "profile_A", enabled: true, scopes: ["crm.catalog.read", "crm.deals.read"] }],
    ["invented-opaque-token-0002", { principal: "person_B", profile: "profile_B",
      selected: "profile_B", enabled: true, scopes: ["crm.catalog.read"] }]
  ]);
  const records = new Map([["profile_A", { catalog: "Alpha catalog", deal: "Alpha deal" }],
    ["profile_B", { catalog: "Beta catalog", deal: "Beta deal" }]]);
  const calls = [];
  const introspect = async ({ token, audience }) => {
    calls.push({ operation: "introspect", audience });
    const session = sessions.get(token);
    if (!session?.enabled || session.selected !== session.profile || audience !== "crm-web")
      return { active: false };
    return { active: true, iss: issuer, aud: "crm-web", sub: session.principal,
      profileId: session.profile, sessionId: `session_${session.principal}`,
      nbf: now - 10, exp: now + 300, scopes: session.scopes };
  };
  const handleScopedRequest = async (received, identity) => {
    calls.push({ operation: "domain", method: received.method, profile: identity.profileId,
      scopes: identity.scopes });
    const path = new URL(received.url).pathname;
    const row = records.get(identity.profileId);
    const value = path.includes("deal-") ? row?.deal : row?.catalog;
    return new Response(JSON.stringify({ profile: identity.profileId, value }), {
      headers: { "content-type": "application/json" } });
  };
  const handler = createConnectedCrmReadBoundary({ enabled: true, issuer, introspect,
    handleScopedRequest, now: () => now });
  return { sessions, records, calls, introspect, handler, handleScopedRequest };
}

test("pinned Control Plane v1 contract grants separate CRM reads and deal creation", () => {
  const sha = bytes => createHash("sha256").update(bytes).digest("hex");
  assert.equal(source.repository, "trained-assist/trained-assist-control-plane");
  assert.equal(source.revision, "a455214645f2a5a05207e8a6ea1ea6ad0215476f");
  assert.equal(sha(contractRaw), source.contractSha256);
  assert.equal(sha(schemaRaw), source.responseSchemaSha256);
  assert.equal(contract.urn, "urn:trained-assist:connected-app-identity:v1");
  assert.equal(contract.status, "offline_contract_only");
  assert.deepEqual(contract.audiences["crm-web"],
    ["crm.catalog.read", "crm.notes.read", "crm.deals.read", "crm.deals.create"]);
  assert.equal(contract.audiences["crm-web"].includes("crm.deals.publish"), false);
  assert.deepEqual(schema.oneOf[1].required, contract.introspection.activeResponseFields);
  assert.deepEqual(contract.introspection.inactiveResponse, { active: false });
  assert.equal(contract.token.agentRunRequired, false);
  assert.equal(contract.token.legacyAgentCookieAllowed, false);
  assert.equal(contract.rules.oldWebJwtOrRunTokenAccepted, false);
});

test("S-01 catalog list and card use one current selected profile on every read", async () => {
  const f = fixture();
  const list = await response(f.handler, `/catalogs/${buildId}`);
  const card = await response(f.handler, `/catalogs/${buildId}/participants/${companyId}`);
  assert.deepEqual(list.body, { profile: "profile_A", value: "Alpha catalog" });
  assert.deepEqual(card.body, list.body);
  assert.deepEqual((await response(f.handler, `/api/v1/catalog-builds/${buildId}/participants`,
    { authorization: "Bearer invented-opaque-token-0002" })).body,
  { profile: "profile_B", value: "Beta catalog" });
  assert.equal(f.calls.filter((call) => call.operation === "introspect").length, 3);
  assert.ok(f.calls.filter((call) => call.operation === "domain")
    .every((call) => call.scopes.includes("crm.catalog.build.read.synthetic") &&
      !call.scopes.some((scope) => scope.includes("confirm"))));
  assert.equal((await response(f.handler, `/catalogs/${buildId}?profileId=profile_B`)).status, 400);
  assert.equal((await response(f.handler, `/catalogs/${buildId}?token=other`)).status, 400);
});

test("profile switch, revocation and lost scope invalidate subsequent catalog reads", async () => {
  const f = fixture();
  assert.equal((await response(f.handler, `/catalogs/${buildId}`)).status, 200);
  f.sessions.get("invented-opaque-token-0001").selected = "profile_B";
  assert.equal((await response(f.handler, `/catalogs/${buildId}`)).status, 401);
  f.sessions.get("invented-opaque-token-0001").selected = "profile_A";
  f.sessions.get("invented-opaque-token-0001").enabled = false;
  assert.equal((await response(f.handler, `/catalogs/${buildId}`)).status, 401);
  f.sessions.get("invented-opaque-token-0001").enabled = true;
  f.sessions.get("invented-opaque-token-0001").scopes = ["crm.deals.read"];
  assert.equal((await response(f.handler, `/catalogs/${buildId}`)).status, 403);
  assert.equal(f.calls.filter((call) => call.operation === "domain").length, 1);
});

test("S-04 deal read is scoped while create, confirm, reconcile and repair never reach domain", async () => {
  const f = fixture();
  assert.deepEqual((await response(f.handler, `/api/v1/deal-reviews/${reviewId}`)).body,
    { profile: "profile_A", value: "Alpha deal" });
  assert.deepEqual((await response(f.handler, `/api/v1/deal-operations/${operationId}`)).body,
    { profile: "profile_A", value: "Alpha deal" });
  assert.equal((await response(f.handler, `/api/v1/deal-reviews/${reviewId}`,
    { authorization: "Bearer invented-opaque-token-0002" })).status, 403);
  for (const path of ["/api/v1/deal-reviews", `/api/v1/deal-reviews/${reviewId}/confirm`,
    `/api/v1/deal-operations/${operationId}/reconcile`, `/api/v1/deal-operations/${operationId}/repair`]) {
    assert.equal((await response(f.handler, path, { method: "POST" })).status, 404);
  }
  assert.equal(f.calls.filter((call) => call.operation === "domain").length, 2);
});

test("malformed token, wrong audience, unsigned profile and unavailable introspection fail closed", async () => {
  const f = fixture();
  assert.equal((await response(f.handler, `/catalogs/${buildId}`, { authorization: "" })).status, 401);
  assert.equal((await response(f.handler, `/catalogs/${buildId}`, { authorization: "Bearer old.jwt" })).status, 401);
  assert.equal((await response(f.handler, `/catalogs/${buildId}`, { authorization: "",
    cookie: "legacy_agent_session=profile_A" })).status, 401);
  for (const bad of [
    { aud: "recruiting-web" }, { profileId: "profile_A", scopes: ["crm.deals.confirm.synthetic"] },
    { exp: now }, { nbf: now + 1 }, { iss: "https://attacker.example.invalid" },
    { profileId: "../profile_B" }, { scopes: ["crm.catalog.read", "crm.catalog.read"] },
    { profileId: "profile_B", token: "browser-supplied" }
  ]) {
    const badHandler = createConnectedCrmReadBoundary({ enabled: true, issuer, now: () => now,
      introspect: async (args) => ({ ...(await f.introspect(args)), ...bad }),
      handleScopedRequest: f.handleScopedRequest });
    assert.equal((await response(badHandler, `/catalogs/${buildId}`)).status, 503);
  }
  const unavailable = createConnectedCrmReadBoundary({ enabled: true, issuer,
    introspect: async () => { throw new Error("offline"); },
    handleScopedRequest: f.handleScopedRequest });
  assert.equal((await response(unavailable, `/catalogs/${buildId}`)).status, 503);
  assert.equal((await response(createConnectedCrmReadBoundary({ issuer, introspect: f.introspect,
    handleScopedRequest: f.handleScopedRequest }), `/catalogs/${buildId}`)).status, 404);
});

test("D1 adapter blocks S-04 mutation before constructing or calling provider", async () => {
  let providerCalls = 0, dbCalls = 0;
  const f = fixture();
  const handler = createConnectedCrmD1ReadHandler({ enabled: true, issuer,
    introspect: f.introspect, now: () => now,
    db: { prepare() { dbCalls++; throw new Error("unexpected D1 access"); }, batch() {} },
    provider: { create() { providerCalls++; throw new Error("unexpected provider access"); } } });
  assert.equal((await response(handler, `/api/v1/deal-reviews/${reviewId}/confirm`, { method: "POST" })).status, 404);
  assert.equal((await response(handler, `/api/v1/deal-operations/${operationId}/repair`, { method: "POST" })).status, 404);
  assert.equal(providerCalls, 0);
  assert.equal(dbCalls, 0);
});
