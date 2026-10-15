#!/usr/bin/env node
// Direct MCP smoke for the deployed synthetic CRM catalog Worker.
// The fixture credential is public test data; only the read-only catalog tool is called.
import assert from "node:assert/strict";

const endpoint = "https://crm-web-connected-mcp-sandbox-20261008b.skillset-apply.workers.dev/mcp";
const fixtureToken = "b".repeat(64);
const exhibitionId = "synthetic-current-source-shape";
const toolName = "crm_exhibitions_catalog_search";
const headers = {
  authorization: `Bearer ${fixtureToken}`,
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  "mcp-protocol-version": "2025-06-18",
};

async function rpc(id, method, params) {
  const response = await fetch(endpoint, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  assert.equal(response.status, 200, `${method} returned HTTP ${response.status}`);
  const message = await response.json();
  assert.equal(message.jsonrpc, "2.0");
  assert.equal(message.id, id);
  assert.equal(message.error, undefined, `${method} returned MCP error ${message.error?.message}`);
  return message.result;
}

const initialized = await rpc("initialize", "initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "crm-public-mcp-catalog-smoke", version: "1" },
});
assert.equal(initialized.protocolVersion, "2025-06-18");

const listed = await rpc("tools-list", "tools/list", {});
const tool = listed.tools?.find(({ name }) => name === toolName);
assert.ok(tool, `${toolName} is not published`);
assert.equal(tool._meta?.capabilityVersion, "1.1.0");
assert.equal(tool._meta?.effect, "read");
assert.deepEqual(tool._meta?.requiredScopes, ["crm.catalog.read"]);

const called = await rpc("catalog-read", "tools/call", {
  name: toolName,
  arguments: { exhibitionId, limit: 5 },
  _meta: { capabilityVersion: tool._meta.capabilityVersion },
});
const catalog = called.structuredContent;
const item = catalog?.items?.[0];
assert.equal(called.isError, false);
assert.equal(catalog?.exhibitionId, exhibitionId);
assert.equal(catalog?.artifactVersion, "1.2.0");
assert.equal(catalog?.items?.length, 1);
assert.equal(item?.name, "Synthetic manufacturing");
assert.equal(item?.classification, "target");
assert.equal(item?.employeeCount, 42);
assert.equal(item?.taxesPaidRub, 1_250_000);

console.log(JSON.stringify({
  result: "PASS",
  environment: "synthetic-sandbox",
  endpoint: new URL(endpoint).origin,
  protocolVersion: initialized.protocolVersion,
  tool: toolName,
  capabilityVersion: tool._meta.capabilityVersion,
  artifactVersion: catalog.artifactVersion,
  syntheticRecord: {
    name: item.name,
    classification: item.classification,
    employeeCount: item.employeeCount,
    taxesPaidRub: item.taxesPaidRub,
  },
  mcpRequests: 3,
}, null, 2));
