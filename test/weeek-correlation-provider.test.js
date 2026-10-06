import test from "node:test";
import assert from "node:assert/strict";
import { createWeeekCorrelationProvider } from "../src/weeek-correlation-provider.js";

const operationId = "op-00000000-0000-4000-8000-000000000001";
const requestHash = "a".repeat(64);
const request = { statusId: "demo-status-lead-a", title: "Example Components Ltd.",
  source: "Example Expo", dealType: "direct", companyInn: "1234567890",
  contactName: "Example Contact", dealComment: "Synthetic note" };
const input = { profileId: "demo-profile-a", operationId, requestHash, request };
const dealId = "demo-deal-00000000-0000-4000-8000-000000000001";

function scenario({ timeout = false, mutate = (deal) => deal, listFailure = false,
  extraMatch = false } = {}) {
  const calls = { post: 0, list: 0, get: 0 };
  let stored;
  const transport = {
    async createDeal({ statusId, body }) {
      calls.post++;
      stored = { id: dealId, statusId, ...body };
      if (timeout) throw new Error("synthetic_timeout_after_post");
      return { success: true, deal: { id: dealId } };
    },
    async listDeals({ statusId, offset }) {
      calls.list++;
      if (listFailure) throw new Error("synthetic_read_failure");
      const deals = statusId === request.statusId && offset === 0 && stored
        ? [mutate(stored), ...(extraMatch ? [{ ...stored,
          id: "demo-deal-00000000-0000-4000-8000-000000000002" }] : [])] : [];
      return { success: true, deals, hasMoreDeals: false };
    },
    async getDeal({ dealId: id }) { calls.get++; return { success: true,
      deal: stored && id === stored.id ? mutate(stored) : null }; }
  };
  const provider = createWeeekCorrelationProvider({ transport,
    resolveStatusIds: async () => [request.statusId, "demo-status-other"] });
  return { provider, calls };
}

test("POST timeout is resolved by complete marker scan and verified GET without second POST", async () => {
  const { provider, calls } = scenario({ timeout: true });
  await assert.rejects(provider.create(input), /synthetic_timeout/);
  const result = await provider.reconcile(input);
  assert.equal(result.status, "created");
  assert.equal(result.dealId, dealId);
  assert.match(result.providerRef, /^\[crm-web-s04:op-/);
  assert.equal(calls.post, 1);
  assert.equal(calls.list, 2);
  assert.equal(calls.get, 1);
});

test("direct success needs a verified receipt bound to marker and reviewed fields", async () => {
  const valid = scenario();
  assert.equal((await valid.provider.create(input)).status, "created");
  assert.equal(valid.calls.get, 1);
  const bad = scenario({ mutate: (deal) => ({ ...deal, title: "Another company" }) });
  assert.equal((await bad.provider.create(input)).status, "unknown");
});

test("multiple, incompatible, or incomplete scans preserve unknown", async () => {
  for (const options of [{ timeout: true, extraMatch: true },
    { timeout: true, mutate: (deal) => ({ ...deal, title: "Wrong title" }) },
    { timeout: true, listFailure: true }]) {
    const { provider, calls } = scenario(options);
    await assert.rejects(provider.create(input));
    assert.equal((await provider.reconcile(input)).status, "unknown");
    assert.equal(calls.post, 1);
  }
});

test("missing marker and unbounded pagination do not establish absence", async () => {
  const noMarker = scenario({ timeout: true,
    mutate: (deal) => ({ ...deal, description: "edited after creation" }) });
  await assert.rejects(noMarker.provider.create(input));
  assert.equal((await noMarker.provider.reconcile(input)).status, "unknown");
  const provider = createWeeekCorrelationProvider({ transport: {
    createDeal: async () => { throw new Error("no post expected"); },
    getDeal: async () => { throw new Error("no detail expected"); },
    listDeals: async () => ({ success: true, deals: [], hasMoreDeals: true })
  }, resolveStatusIds: async () => [request.statusId], maxPages: 2 });
  assert.deepEqual(await provider.reconcile(input), { status: "unknown", reason: "incomplete_scan" });
});
