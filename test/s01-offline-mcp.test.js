import test from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFile } from "node:fs/promises";
import { createServer } from "../src/server.js";
import { createOfflineS01McpClient, createOfflineS01McpServer } from "../src/offline-mcp.js";

const profile = (profileId = "demo-profile-a", scopes = ["crm.companies.read"]) => ({ profileId, scopes });

async function fixture(run, { trusted = profile(), companies } = {}) {
  const state = { companies: companies ?? [{ id: "demo-company-001", name: "Synthetic Participant A", country: "Exampleland", exhibitionIds: ["demo-expo-001"], qualification: { qualification: "target", reason: "fixture-rule-a" } }] };
  const dealIntents = { visibleCompanies: (profileId) => profileId === trusted.profileId ? state.companies.map((item) => structuredClone(item)) : [] };
  const resolveTrustedProfile = () => trusted;
  const http = createServer({ resolveTrustedProfile, dealIntents });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${http.address().port}`;
  const mcpServer = createOfflineS01McpServer({ dealIntents, resolveTrustedProfile });
  const mcp = createOfflineS01McpClient(mcpServer);
  try { await run({ base, mcp, mcpServer, state, http }); }
  finally { await new Promise((resolve, reject) => http.close((error) => error ? reject(error) : resolve())); }
}

test("descriptor is versioned, resolves every schema and binds UI/API/MCP to one handler", async () => {
  const descriptor = JSON.parse(await readFile(new URL("../capabilities/s01-exhibition-participants.v1.json", import.meta.url)));
  assert.equal(descriptor.capabilityId, "crm.exhibitions.participants.read");
  assert.equal(descriptor.version, "1.0.0");
  assert.equal(descriptor.handlerBinding, "src/s01-participants.js#readExhibitionParticipants");
  assert.equal(descriptor.httpBinding, "GET /api/v1/companies");
  assert.deepEqual(descriptor.requiredScopes, ["crm.companies.read"]);
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /fetch\('\/api\/v1\/companies'/);
  const resolvedSchemas = {};
  for (const [name, ref] of Object.entries({ input: descriptor.inputSchemaRef, output: descriptor.outputSchemaRef, errors: descriptor.errorsSchemaRef })) {
    const schema = JSON.parse(await readFile(new URL(`../${ref}`, import.meta.url)));
    assert.ok(schema.$id);
    resolvedSchemas[name] = schema;
  }
  const inputAjv = new Ajv();
  assert.ok(inputAjv.compile(resolvedSchemas.input)({}));
  assert.equal(inputAjv.compile(resolvedSchemas.input)({ profileId: "demo-profile-b" }), false);
  const outputSchema = JSON.parse(await readFile(new URL(`../${descriptor.outputSchemaRef}`, import.meta.url)));
  const ajv = new Ajv();
  addFormats(ajv);
  const validateOutput = ajv.compile(outputSchema);
  await fixture(async ({ base, mcp }) => {
    const api = await fetch(`${base}/api/v1/companies`).then((response) => response.json());
    assert.ok(validateOutput(api), JSON.stringify(validateOutput.errors));
    assert.ok(validateOutput(await mcp.readParticipants()), JSON.stringify(validateOutput.errors));
  });
  const errorAjv = new Ajv();
  const validateError = errorAjv.compile(resolvedSchemas.errors);
  assert.ok(validateError({ code: "SCOPE_DENIED", message: "Required capability scope is missing." }));
});

test("offline MCP JSON-RPC round trip matches API for the trusted profile and stateful fixture", async () => {
  await fixture(async ({ base, mcp, state }) => {
    const apiFirst = await fetch(`${base}/api/v1/companies`).then((response) => response.json());
    const mcpFirst = await mcp.readParticipants();
    assert.deepEqual(mcpFirst, apiFirst);
    assert.deepEqual(apiFirst.items.map(({ id, exhibitionIds, exhibitions }) => ({ id, exhibitionIds, events: exhibitions.map(({ id, name }) => ({ id, name })) })), [{ id: "demo-company-001", exhibitionIds: ["demo-expo-001"], events: [{ id: "demo-expo-001", name: "Example Industry Expo" }] }]);
    assert.equal(apiFirst.items[0].qualification.qualification, "target");

    state.companies[0].qualification = { qualification: "review", reason: "fixture-revised-profile-rule" };
    const apiRevised = await fetch(`${base}/api/v1/companies`).then((response) => response.json());
    const mcpRevised = await mcp.readParticipants();
    assert.deepEqual(mcpRevised, apiRevised);
    assert.equal(mcpRevised.items[0].qualification.qualification, "review");

    const profileB = await createOfflineS01McpClient(createOfflineS01McpServer({
      dealIntents: { visibleCompanies: () => [{ id: "demo-company-002", name: "Synthetic Participant B", country: "Sampleland", exhibitionIds: ["demo-expo-002"], qualification: { qualification: "review", reason: "fixture-rule-b" } }] },
      resolveTrustedProfile: () => profile("demo-profile-b")
    })).readParticipants();
    assert.equal(profileB.items[0].id, "demo-company-002");
    assert.notEqual(profileB.items[0].id, mcpRevised.items[0].id);
    assert.notEqual(profileB.items[0].qualification.reason, mcpRevised.items[0].qualification.reason);
  });
  await fixture(async ({ base, mcp }) => {
    const api = await fetch(`${base}/api/v1/companies`).then((response) => response.json());
    assert.deepEqual(await mcp.readParticipants(), api);
    assert.equal(api.items[0].exhibitions[0].id, "demo-expo-002");
  }, { trusted: profile("demo-profile-b"), companies: [{ id: "demo-company-002", name: "Synthetic Participant B", country: "Sampleland", exhibitionIds: ["demo-expo-002"], qualification: { qualification: "review", reason: "fixture-rule-b" } }] });
});

test("offline MCP rejects wrong tool, capability version, and unexpected arguments", async () => {
  await fixture(async ({ mcpServer }) => {
    const call = (name, version, args) => mcpServer.receive({ jsonrpc: "2.0", id: 20, method: "tools/call", params: { name, arguments: args, _meta: { capabilityVersion: version } } }).then(JSON.parse);
    const protocolMismatch = JSON.parse(await mcpServer.receive({ jsonrpc: "2.0", id: 19, method: "initialize", params: { protocolVersion: "1900-01-01", capabilities: {}, clientInfo: { name: "test", version: "0" } } }));
    assert.equal(protocolMismatch.error.message, "CAPABILITY_VERSION_MISMATCH");
    assert.equal((await call("wrong_tool", "1.0.0", {})).error.message, "UNKNOWN_TOOL");
    assert.equal((await call("crm_exhibitions_participants_read", "9.9.9", {})).error.message, "CAPABILITY_VERSION_MISMATCH");
    assert.equal((await call("crm_exhibitions_participants_read", "1.0.0", { profileId: "demo-profile-b" })).error.message, "INVALID_ARGUMENTS");
  });
});

test("offline MCP fails closed on missing identity or scope and has no Agent Run dependency", async () => {
  const noIdentity = createOfflineS01McpClient(createOfflineS01McpServer({ dealIntents: { visibleCompanies: () => [] }, resolveTrustedProfile: () => null }));
  await assert.rejects(noIdentity.readParticipants(), (error) => error.message === "AUTH_CONTEXT_UNAVAILABLE");
  const noScope = createOfflineS01McpClient(createOfflineS01McpServer({ dealIntents: { visibleCompanies: () => [] }, resolveTrustedProfile: () => profile("demo-profile-a", []) }));
  await assert.rejects(noScope.readParticipants(), (error) => error.message === "SCOPE_DENIED");
  const sources = await Promise.all(["../src/offline-mcp.js", "../src/s01-participants.js"].map((ref) => readFile(new URL(ref, import.meta.url), "utf8")));
  assert.equal(sources.some((source) => /Agent Run|agent-run|runner\.launch|spawnAgentRun/i.test(source)), false);
});

test("UI consumes the same scoped API response and unauthorized API remains fail-closed", async () => {
  await fixture(async ({ base, http }) => {
    const html = await fetch(base).then((response) => response.text());
    assert.match(html, /participant\.exhibitions\.map/);
    assert.match(html, /participant\.qualification\.qualification/);
    const api = await fetch(`${base}/api/v1/companies`).then((response) => response.json());
    assert.deepEqual(api.items.map((item) => [item.id, item.exhibitions[0].id, item.exhibitions[0].name, item.qualification.qualification]), [["demo-company-001", "demo-expo-001", "Example Industry Expo", "target"]]);
  });
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/companies`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "trusted_profile_unavailable" });
  } finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});
