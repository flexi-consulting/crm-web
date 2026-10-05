import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/server.js";
import { createConfirmedDealService } from "../src/confirmed-deals.js";
import { createPreleadTimelineService } from "../src/prelead-timeline.js";
import { createDealReviewService } from "../src/deal-reviews.js";
import { createOfflineS04McpServer, s04DealCapability } from "../src/s04-deals.js";

const scopes = [...new Set(s04DealCapability.tools.map((tool) => tool.scope).concat(["crm.preleads.read"]))];
const identity = { profileId: "demo-profile-a", scopes };
const draft = { companyId: "demo-company-001", exhibitionId: "demo-expo-001", title: "Sample deal", companyInn: "0000000000", contactName: "Synthetic Contact", dealComment: "Synthetic review comment" };

async function fixture(provider) {
  const timeline = createPreleadTimelineService();
  const dealService = createConfirmedDealService({ provider, preleadTimeline: timeline });
  const reviewService = createDealReviewService({ confirmedDeals: dealService, preleadTimeline: timeline });
  const approved = new Map();
  const receipt = ({ profileId, reviewId, revision }) => approved.get(reviewId)?.revision === revision
    ? { profileId, reviewId, revision, actorId: "synthetic-human-actor", approved: true } : null;
  const server = createServer({ preleadTimeline: timeline, confirmedDeals: dealService, reviewService,
    resolveTrustedProfile: () => identity,
    resolveTrustedReviewReceipt: (req, context) => receipt({ profileId: context.profileId,
      reviewId: req.url.match(/review-[0-9a-f-]{36}/)?.[0], revision: approved.get(req.url.match(/review-[0-9a-f-]{36}/)?.[0])?.revision }) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mcp = createOfflineS04McpServer({ dealService, reviewService, resolveTrustedProfile: () => identity, resolveTrustedReviewReceipt: receipt });
  let id = 0;
  async function call(method, params) {
    const raw = await mcp.receive(JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }));
    const result = JSON.parse(raw);
    if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code, data: result.error.data });
    return result.result;
  }
  await call("initialize", { protocolVersion: s04DealCapability.protocolVersion });
  await mcp.receive(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  return { timeline, dealService, reviewService, approved, base,
    tool: (name, args) => call("tools/call", { name, arguments: args, _meta: { capabilityVersion: s04DealCapability.version } }),
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

test("review includes all legacy required fields and same handler serves web/MCP", async () => {
  let creates = 0, captured;
  const provider = { async create({ operationId, request }) { creates++; captured = request; return { status: "created", dealId: `demo-deal-${operationId.slice(3)}` }; }, async reconcile() { return { status: "unknown" }; }, async repairLink() { return true; } };
  const f = await fixture(provider);
  try {
    f.timeline.appendEvent({ profileId: identity.profileId, preleadId: "demo-prelead-001", request: { type: "note_added", noteText: "Synthetic visitor note", operationId: "op-00000000-0000-4000-8000-000000000098" } });
    const prepared = (await f.tool("crm_deal_prepare_from_participant", draft)).structuredContent;
    assert.deepEqual(Object.keys(prepared.details).sort(), ["companyId", "companyInn", "contactName", "dealComment", "dealType", "exhibitionId", "notesCount", "source", "statusId", "title"].sort());
    assert.equal(prepared.details.statusId, "demo-status-lead-a");
    assert.equal(prepared.details.source, "Example Industry Expo");
    assert.equal(prepared.details.dealType, "direct");
    assert.equal(prepared.details.notesCount, 1);
    assert.match(prepared.details.dealComment, /Synthetic visitor note/);
    assert.deepEqual(await (await fetch(`${f.base}/api/v1/deal-reviews/${prepared.reviewId}`)).json(), prepared);
    await assert.rejects(() => f.tool("crm_deal_create_from_participant", { reviewId: prepared.reviewId, revision: prepared.revision }), { message: "trusted_review_confirmation_required" });
    assert.equal(creates, 0);
    f.approved.set(prepared.reviewId, { revision: prepared.revision });
    const confirmation = await fetch(`${f.base}/api/v1/deal-reviews/${prepared.reviewId}/confirm`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: prepared.revision }) });
    assert.equal(confirmation.status, 201);
    const created = await confirmation.json();
    assert.equal(created.status, "created");
    assert.equal(created.linkStatus, "linked");
    assert.equal(captured.companyInn, draft.companyInn);
    assert.equal(captured.contactName, draft.contactName);
    assert.equal(captured.statusId, prepared.details.statusId);
    assert.match(captured.dealComment, /Synthetic visitor note/);
    assert.deepEqual(await (await fetch(`${f.base}/api/v1/deal-operations/${prepared.operationId}`)).json(), created);
    const reviewedAfterConfirm = await (await fetch(`${f.base}/api/v1/deal-reviews/${prepared.reviewId}`)).json();
    assert.equal(reviewedAfterConfirm.status, "created");
    assert.equal(reviewedAfterConfirm.dealId, created.dealId);
    const replay = (await f.tool("crm_deal_create_from_participant", { reviewId: prepared.reviewId, revision: prepared.revision })).structuredContent;
    assert.equal(replay.dealId, created.dealId);
    const secondReview = (await f.tool("crm_deal_prepare_from_participant", draft)).structuredContent;
    f.approved.set(secondReview.reviewId, { revision: secondReview.revision });
    await assert.rejects(() => f.tool("crm_deal_create_from_participant", { reviewId: secondReview.reviewId, revision: secondReview.revision }), { message: "participant_deal_exists" });
    assert.equal(creates, 1);
  } finally { await f.close(); }
});

test("review refuses notes from a prelead bound to another exhibition", () => {
  const timeline = createPreleadTimelineService({ preleads: [{ id: "demo-prelead-001", profileId: "demo-profile-a",
    companyId: "demo-company-001", exhibitionId: "demo-expo-002", stage: "draft" }] });
  timeline.appendEvent({ profileId: "demo-profile-a", preleadId: "demo-prelead-001", request: {
    type: "note_added", noteText: "Wrong event note", operationId: "op-00000000-0000-4000-8000-000000000097" } });
  const reviews = createDealReviewService({ confirmedDeals: {}, preleadTimeline: timeline });
  const result = reviews.prepare({ profileId: "demo-profile-a", request: draft });
  assert.equal(result.status, 404);
  assert.equal(result.body.error, "company_or_exhibition_not_found");
});

test("changed notes invalidate revision and model-authored confirmation never creates", async () => {
  let creates = 0;
  const provider = { async create() { creates++; throw Error("must not create"); }, async reconcile() { return { status: "unknown" }; }, async repairLink() { return true; } };
  const f = await fixture(provider);
  try {
    await assert.rejects(() => f.tool("crm_deal_prepare_from_participant", { ...draft, contactName: "" }), { message: "INVALID_ARGUMENTS" });
    const prepared = (await f.tool("crm_deal_prepare_from_participant", draft)).structuredContent;
    f.approved.set(prepared.reviewId, { revision: prepared.revision });
    await assert.rejects(() => f.tool("crm_deal_create_from_participant", { reviewId: prepared.reviewId, revision: prepared.revision, confirmation: true }), { message: "INVALID_ARGUMENTS" });
    f.timeline.appendEvent({ profileId: identity.profileId, preleadId: "demo-prelead-001", request: { type: "note_added", noteText: "New synthetic note", operationId: "op-00000000-0000-4000-8000-000000000099" } });
    await assert.rejects(() => f.tool("crm_deal_create_from_participant", { reviewId: prepared.reviewId, revision: prepared.revision }), { message: "review_stale" });
    assert.equal(creates, 0);
    const updated = (await f.tool("crm_deal_prepare_from_participant", draft)).structuredContent;
    assert.notEqual(updated.revision, prepared.revision);
    assert.match(updated.details.dealComment, /New synthetic note/);
  } finally { await f.close(); }
});

test("scope and profile isolate reviews; direct unreviewed route fails closed by default", async () => {
  const f = await fixture({ async create() { throw Error("must not create"); }, async reconcile() { return { status: "unknown" }; }, async repairLink() { return true; } });
  try {
    const prepared = (await f.tool("crm_deal_prepare_from_participant", draft)).structuredContent;
    identity.scopes = [];
    await assert.rejects(() => f.tool("crm_deal_create_from_participant", { reviewId: prepared.reviewId, revision: prepared.revision }), { message: "SCOPE_DENIED" });
    identity.scopes = scopes;
    identity.profileId = "demo-profile-b";
    await assert.rejects(() => f.tool("crm_deal_create_from_participant", { reviewId: prepared.reviewId, revision: prepared.revision }), { message: "review_not_found" });
    identity.profileId = "demo-profile-a";
    const direct = await fetch(`${f.base}/api/v1/deals/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmation: true }) });
    assert.equal(direct.status, 404);
  } finally { identity.profileId = "demo-profile-a"; identity.scopes = scopes; await f.close(); }
});

test("MCP lifecycle requires version negotiation", async () => {
  const server = createOfflineS04McpServer({ dealService: {}, reviewService: {}, resolveTrustedProfile: () => identity });
  await server.receive(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  const list = () => server.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
  assert.equal(JSON.parse(await list()).error.message, "NOT_INITIALIZED");
  await server.receive(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: s04DealCapability.protocolVersion } }));
  await server.receive(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  assert.equal(JSON.parse(await list()).result.tools.length, 5);
});
