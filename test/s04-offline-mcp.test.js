import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "../src/server.js";
import { createConfirmedDealService } from "../src/confirmed-deals.js";
import { createPreleadTimelineService } from "../src/prelead-timeline.js";
import { createOfflineS04McpServer, s04DealCapability } from "../src/s04-deals.js";

const opId = (n) => `op-00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const request = (n) => ({ companyId: "demo-company-001", exhibitionId: "demo-expo-001", title: "Sample deal", summary: "Synthetic notes", confirmation: true, operationId: opId(n) });
const scopes = s04DealCapability.tools.map((tool) => tool.scope).concat("crm.preleads.read");
const identity = { profileId: "demo-profile-a", scopes };

async function fixture(provider) {
  const timeline = createPreleadTimelineService();
  const dealService = createConfirmedDealService({ provider, preleadTimeline: timeline });
  const server = createServer({ preleadTimeline: timeline, confirmedDeals: dealService, resolveTrustedProfile: () => identity });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mcp = createOfflineS04McpServer({ dealService, resolveTrustedProfile: () => identity });
  let id = 0;
  async function call(method, params) {
    const raw = await mcp.receive(JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }));
    const result = JSON.parse(raw);
    if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code, data: result.error.data });
    return result.result;
  }
  await call("initialize", { protocolVersion: s04DealCapability.protocolVersion });
  await mcp.receive(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  const listed = await call("tools/list", {});
  assert.deepEqual(listed.tools.map((tool) => tool.name), s04DealCapability.tools.map((tool) => tool.name));
  return {
    timeline, dealService, base, listed,
    tool: (name, args) => call("tools/call", { name, arguments: args, _meta: { capabilityVersion: s04DealCapability.version } }),
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

test("S-04 web and offline MCP share one confirmed deal and canonical prelead event", async () => {
  let creates = 0;
  const provider = { async create({ operationId }) { creates++; return { status: "created", dealId: `demo-deal-${operationId.slice(3)}` }; }, async reconcile() { throw Error("unused"); }, async repairLink() { return true; } };
  const f = await fixture(provider);
  try {
    const created = (await f.tool("crm_deal_create_from_participant", { idempotencyKey: "key-s04-0001", request: request(1) })).structuredContent;
    assert.equal(created.status, "created");
    assert.equal(created.linkStatus, "linked");
    const web = await fetch(`${f.base}/api/v1/deal-operations/${opId(1)}`);
    assert.deepEqual(await web.json(), created);
    const timeline = await fetch(`${f.base}/api/v1/preleads/demo-prelead-001/timeline`);
    const body = await timeline.json();
    assert.equal(body.prelead.disposition, "deal");
    assert.deepEqual(body.events.filter((event) => event.type === "deal_linked").map((event) => event.payload.dealId), [created.dealId]);
    const replay = (await f.tool("crm_deal_create_from_participant", { idempotencyKey: "key-s04-0001", request: request(1) })).structuredContent;
    assert.equal(replay.dealId, created.dealId);
    assert.equal(creates, 1);
    await assert.rejects(() => f.tool("crm_deal_create_from_participant", { idempotencyKey: "key-s04-0002", request: request(2) }), { message: "participant_deal_exists" });
    assert.equal(creates, 1);
  } finally { await f.close(); }
});

test("unknown result is reconciled without a second create; link repair updates timeline", async () => {
  let creates = 0, linked = false;
  const provider = { async create() { creates++; throw Error("timeout after dispatch"); }, async reconcile(operationId) { return { status: "created", dealId: `demo-deal-${operationId.slice(3)}` }; }, async repairLink() { return linked; } };
  const f = await fixture(provider);
  try {
    const unknown = (await f.tool("crm_deal_create_from_participant", { idempotencyKey: "key-s04-0003", request: request(3) })).structuredContent;
    assert.equal(unknown.status, "unknown");
    assert.equal(f.timeline.getTimeline({ profileId: "demo-profile-a", preleadId: "demo-prelead-001" }).body.events.length, 0);
    const reconciled = (await f.tool("crm_deal_reconcile_operation", { operationId: opId(3) })).structuredContent;
    assert.equal(reconciled.status, "created");
    assert.equal(reconciled.linkStatus, undefined);
    await assert.rejects(() => f.tool("crm_deal_repair_catalog_link", { operationId: opId(3) }), { message: "link_repair_failed" });
    linked = true;
    const repaired = (await f.tool("crm_deal_repair_catalog_link", { operationId: opId(3) })).structuredContent;
    assert.equal(repaired.linkStatus, "linked");
    assert.equal(creates, 1);
  } finally { await f.close(); }
});

test("S-04 tool rejects missing scope, other profile and invalid arguments", async () => {
  const f = await fixture({ async create() { throw Error("must not create"); }, async reconcile() { return { status: "unknown" }; }, async repairLink() { return true; } });
  try {
    await assert.rejects(() => f.tool("crm_deal_create_from_participant", { idempotencyKey: "short", request: request(4) }), { message: "INVALID_ARGUMENTS" });
    identity.scopes = [];
    await assert.rejects(() => f.tool("crm_deal_get_operation", { operationId: opId(4) }), { message: "SCOPE_DENIED" });
    identity.scopes = scopes;
    identity.profileId = "demo-profile-b";
    await assert.rejects(() => f.tool("crm_deal_get_operation", { operationId: opId(4) }), { message: "operation_not_found" });
  } finally { identity.profileId = "demo-profile-a"; identity.scopes = scopes; await f.close(); }
});

test("concurrent different keys for one participant reserve one provider operation", async () => {
  let creates = 0, release;
  const gate = new Promise((resolve) => { release = resolve; });
  const provider = { async create({ operationId }) { creates++; await gate; return { status: "created", dealId: `demo-deal-${operationId.slice(3)}` }; }, async reconcile() { return { status: "unknown" }; }, async repairLink() { return true; } };
  const f = await fixture(provider);
  try {
    const first = f.tool("crm_deal_create_from_participant", { idempotencyKey: "key-s04-0005", request: request(5) });
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(() => f.tool("crm_deal_create_from_participant", { idempotencyKey: "key-s04-0006", request: request(6) }), { message: "participant_deal_exists" });
    release();
    assert.equal((await first).structuredContent.status, "created");
    assert.equal(creates, 1);
  } finally { release(); await f.close(); }
});

test("reconciling an old rejection cannot remove a newer participant reservation", async () => {
  let release, creates = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const provider = {
    async create({ operationId }) {
      creates++;
      if (operationId === opId(7)) return { status: "rejected" };
      await gate;
      return { status: "created", dealId: `demo-deal-${operationId.slice(3)}` };
    },
    async reconcile() { return { status: "rejected" }; },
    async repairLink() { return true; }
  };
  const f = await fixture(provider);
  try {
    assert.equal((await f.dealService.create({ profileId: identity.profileId, idempotencyKey: "key-s04-0007", request: request(7) })).body.status, "rejected");
    const second = f.dealService.create({ profileId: identity.profileId, idempotencyKey: "key-s04-0008", request: request(8) });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await f.dealService.reconcile({ profileId: identity.profileId, operationId: opId(7) })).body.status, "rejected");
    assert.equal((await f.dealService.create({ profileId: identity.profileId, idempotencyKey: "key-s04-0009", request: request(9) })).body.error, "participant_deal_exists");
    release();
    assert.equal((await second).body.status, "created");
    assert.equal(creates, 2);
  } finally { release(); await f.close(); }
});

test("MCP initialized notification cannot bypass protocol negotiation", async () => {
  const server = createOfflineS04McpServer({ dealService: {}, resolveTrustedProfile: () => identity });
  await server.receive(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  const list = () => server.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
  assert.equal(JSON.parse(await list()).error.message, "NOT_INITIALIZED");
  const mismatch = await server.receive(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "unsupported" } }));
  assert.equal(JSON.parse(mismatch).error.message, "CAPABILITY_VERSION_MISMATCH");
  await server.receive(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  assert.equal(JSON.parse(await list()).error.message, "NOT_INITIALIZED");
  const accepted = await server.receive(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "initialize", params: { protocolVersion: s04DealCapability.protocolVersion } }));
  assert.equal(JSON.parse(accepted).result.protocolVersion, s04DealCapability.protocolVersion);
  assert.equal(JSON.parse(await list()).error.message, "NOT_INITIALIZED");
  await server.receive(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  assert.equal(JSON.parse(await list()).result.tools.length, 4);
});

test("S-04 offline route uses app handlers without an Agent Run dependency", async () => {
  const sources = await Promise.all(["../src/s04-deals.js", "../src/confirmed-deals.js", "../src/prelead-timeline.js"].map((ref) => readFile(new URL(ref, import.meta.url), "utf8")));
  assert.equal(sources.some((source) => /Agent Run|agent-run|runner\.launch|spawnAgentRun/i.test(source)), false);
  for (const source of sources) {
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
    assert.equal(imports.some((specifier) => !specifier.startsWith("node:") && !specifier.startsWith(".") && specifier !== "ajv/dist/2020.js"), false);
  }
});
