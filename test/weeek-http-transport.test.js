import test from "node:test";
import assert from "node:assert/strict";
import { createWeeekHttpTransport } from "../src/weeek-http-transport.js";
import { createWeeekCorrelationProvider } from "../src/weeek-correlation-provider.js";

const operationId = "op-00000000-0000-4000-8000-000000000001";
const input = { profileId: "demo-profile-a", operationId, requestHash: "a".repeat(64),
  request: { statusId: "status-a", title: "Invented Components", source: "Example Expo",
    dealType: "direct", companyInn: "0000000001", contactName: "Example Contact",
    dealComment: "Synthetic interest" } };
const ok = (body) => new Response(JSON.stringify({ success: true, ...body }),
  { status: 200, headers: { "content-type": "application/json" } });

test("profile token and exact Weeek endpoints carry a reviewed marker through timeout reconciliation", async () => {
  const calls = [], resolvedProfiles = [];
  let stored;
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    calls.push({ method: options.method, path: parsed.pathname, query: parsed.searchParams,
      auth: options.headers.Authorization });
    assert.equal(parsed.origin, "https://api.weeek.net");
    assert.equal(options.headers.Authorization, "Bearer private-profile-a-token");
    if (options.method === "POST") {
      stored = { id: "deal-a", statusId: "status-a", ...JSON.parse(options.body) };
      throw new Error("synthetic_timeout_after_post");
    }
    if (parsed.pathname.endsWith("/deals/deal-a")) return ok({ deal: stored });
    if (parsed.pathname.endsWith("/statuses/status-a/deals"))
      return ok({ deals: [stored], hasMoreDeals: false });
    if (parsed.pathname.endsWith("/statuses/status-b/deals"))
      return ok({ deals: [], hasMoreDeals: false });
    throw new Error("unexpected_url");
  };
  const transport = createWeeekHttpTransport({ fetchImpl, resolveToken: async (profileId) => {
    resolvedProfiles.push(profileId);
    return profileId === input.profileId ? "private-profile-a-token" : null;
  } });
  const provider = createWeeekCorrelationProvider({ transport,
    resolveStatusIds: async (profileId) => {
      assert.equal(profileId, input.profileId);
      return ["status-a", "status-b"];
    } });
  await assert.rejects(provider.create(input), /synthetic_timeout_after_post/);
  const outcome = await provider.reconcile(input);
  assert.equal(outcome.status, "created");
  assert.equal(outcome.dealId, "deal-a");
  assert.match(stored.description, /\[crm-web-s04:op-/);
  assert.deepEqual(calls.map((call) => [call.method, call.path]), [
    ["POST", "/public/v1/crm/statuses/status-a/deals"],
    ["GET", "/public/v1/crm/statuses/status-a/deals"],
    ["GET", "/public/v1/crm/statuses/status-b/deals"],
    ["GET", "/public/v1/crm/deals/deal-a"]
  ]);
  assert.equal(calls[1].query.get("limit"), "100");
  assert.equal(calls[1].query.get("offset"), "0");
  assert.deepEqual(resolvedProfiles, Array(4).fill(input.profileId));
});

test("invalid identity, scope, envelopes and provider failures fail closed without leaking tokens", async () => {
  const calls = [];
  const transport = createWeeekHttpTransport({
    resolveToken: async (profileId) => profileId === "demo-profile-a" ? "secret-value" : null,
    fetchImpl: async (url) => { calls.push(url); return ok({ deals: [], hasMoreDeals: false }); }
  });
  await assert.rejects(transport.listDeals({ profileId: "demo-profile-b", statusId: "status-a",
    limit: 100, offset: 0 }), /weeek_token_unavailable/);
  await assert.rejects(transport.listDeals({ profileId: "demo-profile-a", statusId: "../other",
    limit: 100, offset: 0 }), /weeek_list_invalid/);
  await assert.rejects(transport.getDeal({ profileId: "demo-profile-a", dealId: "deal-a" }),
    /weeek_response_invalid/);
  assert.equal(calls.length, 1);
  const bad = createWeeekHttpTransport({ resolveToken: async () => "secret-value",
    fetchImpl: async () => new Response("private provider body", { status: 500 }) });
  await assert.rejects(bad.getDeal({ profileId: "demo-profile-a", dealId: "deal-a" }),
    (error) => error.message === "weeek_provider_unavailable");
  const malformed = createWeeekHttpTransport({ resolveToken: async () => "secret-value",
    fetchImpl: async () => ok({ deals: [{ id: "deal-a" }], hasMoreDeals: "true" }) });
  await assert.rejects(malformed.listDeals({ profileId: "demo-profile-a", statusId: "status-a",
    limit: 1, offset: 0 }), /weeek_response_invalid/);
});
