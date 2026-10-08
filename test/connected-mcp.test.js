import test from "node:test";
import assert from "node:assert/strict";
import capability from "../capabilities/s01-exhibition-catalog-search.v1.1.json" with { type: "json" };
import inputSchema from "../schemas/s01-catalog-search-input.schema.json" with { type: "json" };
import { createCrmConnectedMcpHandler } from "../src/connected-mcp.js";

const request = (body, options = {}) => new Request("https://crm.example.test/mcp", {
  method: "POST",
  headers: { accept: "application/json, text/event-stream", "content-type": "application/json",
    "mcp-protocol-version": capability.mcpTool.protocolVersion, ...options.headers },
  body: JSON.stringify(body)
});
const rpc = (id, method, params = {}) => ({ jsonrpc: "2.0", id, method, params });
const call = (id, args, meta = { capabilityVersion: capability.version }) => rpc(id, "tools/call", {
  name: capability.mcpTool.name, arguments: args, _meta: meta
});

test("MCP initialize and tools/list publish the descriptor-pinned catalog tool", async () => {
  const handler = createCrmConnectedMcpHandler({ enabled: true, handleRead: async () => Response.json({}) });
  const initialized = await handler(request(rpc(1, "initialize", {
    protocolVersion: capability.mcpTool.protocolVersion, capabilities: {}, clientInfo: { name: "test", version: "1" }
  })));
  assert.equal(initialized.status, 200);
  assert.deepEqual(await initialized.json(), { jsonrpc: "2.0", id: 1, result: {
    protocolVersion: capability.mcpTool.protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: "crm-web", version: capability.version }
  } });
  const listed = await handler(request(rpc(2, "tools/list")));
  const tool = (await listed.json()).result.tools[0];
  assert.equal(tool.name, capability.mcpTool.name);
  assert.equal(tool._meta.capabilityId, capability.capabilityId);
  assert.equal(tool._meta.capabilityVersion, capability.version);
  assert.deepEqual(tool.inputSchema, inputSchema);
});

test("MCP tool call forwards only declared arguments and the Agent bearer to the canonical read handler", async () => {
  let observed;
  const expected = { domainApiVersion: "1.1.0", artifactVersion: "1.2.0", exhibitionId: "demo-show",
    sourceRevision: "synthetic-r1", total: 1, limit: 5, offset: 0, items: [{ id: "demo-company-001" }] };
  const handler = createCrmConnectedMcpHandler({ enabled: true, handleRead: async received => {
    observed = received;
    return Response.json(expected);
  } });
  const response = await handler(request(call(3, { exhibitionId: "demo-show", query: "Acme & Sons", limit: 5 }), {
    headers: { authorization: `Bearer ${"a".repeat(64)}`, cookie: "must-not-forward" }
  }));
  const message = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(message.result.structuredContent, expected);
  assert.equal(message.result.content[0].text, JSON.stringify(expected));
  assert.equal(new URL(observed.url).pathname, "/api/v1/catalogs/demo-show/entries");
  assert.equal(new URL(observed.url).searchParams.get("query"), "Acme & Sons");
  assert.equal(new URL(observed.url).searchParams.get("limit"), "5");
  assert.equal(observed.headers.get("authorization"), `Bearer ${"a".repeat(64)}`);
  assert.equal(observed.headers.has("cookie"), false);
  assert.equal(new URL(observed.url).searchParams.has("profileId"), false);
});

test("MCP denies unknown, unpinned and invalid calls before invoking the app", async () => {
  let calls = 0;
  const handler = createCrmConnectedMcpHandler({ enabled: true, handleRead: async () => {
    calls++;
    return Response.json({});
  } });
  const unknown = await handler(request(rpc(1, "tools/call", { name: "crm_unlisted", arguments: {} })));
  assert.equal((await unknown.json()).error.message, "UNKNOWN_TOOL");
  const unpinned = await handler(request(call(2, { exhibitionId: "demo-show" }, {})));
  assert.equal((await unpinned.json()).error.message, "CAPABILITY_VERSION_MISMATCH");
  const malformed = await handler(request(call(3, { exhibitionId: "demo-show", profileId: "profile-forged" })));
  assert.equal((await malformed.json()).error.message, "INVALID_ARGUMENTS");
  const wrongVersion = await handler(request(call(4, { exhibitionId: "demo-show" }, { capabilityVersion: "99.0.0" })));
  assert.equal((await wrongVersion.json()).error.message, "CAPABILITY_VERSION_MISMATCH");
  assert.equal(calls, 0);
});

test("MCP maps canonical authorization and domain errors without false success", async () => {
  for (const [status, code] of [[401, "AUTH_CONTEXT_UNAVAILABLE"], [403, "SCOPE_DENIED"],
    [404, "NOT_FOUND"], [503, "AUTH_CONTEXT_UNAVAILABLE"]]) {
    const handler = createCrmConnectedMcpHandler({ enabled: true, handleRead: async () =>
      Response.json({ error: "synthetic_error" }, { status }) });
    const response = await handler(request(call(1, { exhibitionId: "demo-show" })));
    const result = await response.json();
    assert.equal(result.error.message, code);
    assert.equal(result.jsonrpc, "2.0");
  }
});

test("MCP HTTP endpoint is opt-in, JSON-only, bounded and stateless", async () => {
  const handler = createCrmConnectedMcpHandler({ enabled: false, handleRead: async () => Response.json({}) });
  assert.equal((await handler(request(rpc(1, "tools/list")))).status, 404);
  const enabled = createCrmConnectedMcpHandler({ enabled: true, handleRead: async () => Response.json({}) });
  assert.equal((await enabled(new Request("https://crm.example.test/mcp", { method: "GET" }))).status, 405);
  assert.equal((await enabled(new Request("https://crm.example.test/mcp", { method: "POST",
    headers: { accept: "text/event-stream", "content-type": "application/json" }, body: "{}" }))).status, 406);
  assert.equal((await enabled(new Request("https://crm.example.test/mcp", { method: "POST",
    headers: { accept: "application/json" }, body: "{}" }))).status, 415);
  const notification = await enabled(request({ jsonrpc: "2.0", method: "notifications/initialized" }));
  assert.equal(notification.status, 202);
  assert.equal(notification.headers.get("cache-control"), "no-store");
  const invalidId = await enabled(request({ jsonrpc: "2.0", id: {}, method: "tools/list" }));
  assert.equal(invalidId.status, 200);
  assert.equal((await invalidId.json()).error.code, -32600);
  const unsupportedVersion = await enabled(request(rpc(2, "tools/list"), {
    headers: { "mcp-protocol-version": "2025-03-26" }
  }));
  assert.equal(unsupportedVersion.status, 400);
  assert.equal((await unsupportedVersion.json()).error.message, "UNSUPPORTED_PROTOCOL_VERSION");
  const missingVersion = await enabled(new Request("https://crm.example.test/mcp", { method: "POST",
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
    body: JSON.stringify(rpc(3, "tools/list")) }));
  assert.equal(missingVersion.status, 400);
});
