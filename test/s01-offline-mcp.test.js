import test from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFile } from "node:fs/promises";
import { createServer } from "../src/server.js";
import { createOfflineS01McpClient, createOfflineS01McpServer } from "../src/offline-mcp.js";
import { s01CatalogSearchCapability } from "../src/s01-catalog-search.js";
import { createCatalogV11SearchHandler, createCatalogV12D1Repository } from "../src/catalog-query-v11.js";
import { importLegacyExSnapshotV12, projectLegacyExSnapshotV12 } from "../src/legacy-ex-snapshot.js";
import initSqlJs from "sql.js";

const profile = (profileId = "demo-profile-a", scopes = ["crm.companies.read"]) => ({ profileId, scopes });

async function fixture(run, { trusted = profile(), companies } = {}) {
  const state = { companies: companies ?? [{ id: "demo-company-001", name: "Synthetic Participant A", country: "Exampleland", exhibitionIds: ["demo-expo-001"], qualification: { qualification: "target", reason: "fixture-rule-a" } }] };
  const dealIntents = { visibleCompanies: (profileId) => profileId === trusted.profileId ? state.companies.map((item) => structuredClone(item)) : [] };
  const resolveTrustedProfile = () => trusted;
  const artifact = { schemaVersion: "1.1.0", exhibitionId: "demo-expo-001", sourceRevision: "synthetic-revision-1", companies: [
    { id: "co-0123456789abcdef0123", name: "Synthetic Catalog Company", source: {
      sourceRecordId: "src-synthetic-catalog", country: "Exampleland", booth: "A-17", href: "https://example.invalid/company",
      category: "Synthetic machinery", description: "Synthetic description", segment: "synthetic segment", duplicateSourceRecordIds: [] },
      enrichment: { status: "found", inn: "0000000001", ogrn: "0000000000001", revenueRub: 500000000,
        revenueYear: 2025, profitRub: 100000000, profitYear: 2024, activity: "manufacturer",
        website: "https://example.invalid/company", provenance: { provider: "synthetic", fixtureRef: "synthetic-catalog" } },
      registry: { status: "ok", provenance: { source: "synthetic", fixtureRef: "synthetic-catalog" } },
      qualification: { classification: "target", target: true, nearTarget: false, reason: "synthetic_rule" } }
  ] };
  const catalogV11Repository = { async getArtifact({ profileId, exhibitionId }) {
    return profileId === trusted.profileId && exhibitionId === artifact.exhibitionId ? structuredClone(artifact) : null;
  } };
  const catalogSearchHandler = createCatalogV11SearchHandler({ repository: catalogV11Repository, resolveTrustedProfile });
  const http = createServer({ resolveTrustedProfile, dealIntents, catalogV11Repository,
    resolveCatalogV11TrustedProfile: resolveTrustedProfile });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${http.address().port}`;
  const mcpServer = createOfflineS01McpServer({ dealIntents, resolveTrustedProfile, catalogSearchHandler });
  const mcp = createOfflineS01McpClient(mcpServer);
  try { await run({ base, mcp, mcpServer, state, http, artifact }); }
  finally { await new Promise((resolve, reject) => http.close((error) => error ? reject(error) : resolve())); }
}

test("descriptor is versioned, resolves every schema and binds UI/API/MCP to one handler", async () => {
  const descriptor = JSON.parse(await readFile(new URL("../capabilities/s01-exhibition-participants.v1.json", import.meta.url)));
  assert.equal(descriptor.capabilityId, "crm.exhibitions.participants.read");
  assert.equal(descriptor.version, "1.0.0");
  assert.equal(descriptor.handlerBinding, "src/s01-participants.js#readExhibitionParticipants");
  assert.equal(descriptor.httpBinding, "GET /api/v1/companies");
  assert.deepEqual(descriptor.requiredScopes, ["crm.companies.read"]);
  const catalogDescriptor = JSON.parse(await readFile(new URL("../capabilities/s01-exhibition-catalog-search.v1.1.json", import.meta.url)));
  assert.deepEqual(catalogDescriptor, s01CatalogSearchCapability);
  assert.equal(catalogDescriptor.capabilityId, "crm.exhibitions.catalog.search");
  assert.equal(catalogDescriptor.httpBinding, "GET /api/v1/catalogs/{exhibitionId}/entries");
  assert.equal(catalogDescriptor.handlerBinding, "src/catalog-query-v11.js#createCatalogV12CompatibleSearchHandler");
  assert.deepEqual(catalogDescriptor.requiredScopes, ["crm.catalog.read"]);
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
  await fixture(async ({ base, mcp, mcpServer }) => {
    const listed = JSON.parse(await mcpServer.receive({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
    assert.deepEqual(listed.result.tools[0].inputSchema, resolvedSchemas.input);
    assert.equal(listed.result.tools.some(tool => tool.name === catalogDescriptor.mcpTool.name), true);
    const api = await fetch(`${base}/api/v1/companies`).then((response) => response.json());
    assert.ok(validateOutput(api), JSON.stringify(validateOutput.errors));
    assert.ok(validateOutput(await mcp.readParticipants()), JSON.stringify(validateOutput.errors));
  });
  const errorAjv = new Ajv();
  const validateError = errorAjv.compile(resolvedSchemas.errors);
  assert.ok(validateError({ code: "SCOPE_DENIED", message: "Required capability scope is missing." }));
});

test("catalog UI HTTP route and Agent MCP capability share the private paged search and safe projection", async () => {
  await fixture(async ({ base, mcp, mcpServer, artifact }) => {
    const scope = profile("demo-profile-a", ["crm.companies.read", "crm.catalog.read"]);
    const searchPath = `/api/v1/catalogs/${artifact.exhibitionId}/entries?query=Synthetic&limit=10`;
    const apiResponse = await fetch(`${base}${searchPath}`, { headers: {
      "x-test-profile": scope.profileId, "x-test-scopes": scope.scopes.join(" ")
    } });
    assert.equal(apiResponse.status, 200);
    const api = await apiResponse.json();
    const search = await mcp.searchCatalog({ exhibitionId: artifact.exhibitionId, query: "Synthetic", limit: 10 });
    assert.deepEqual(search, api);
    assert.equal(api.total, 1);
    assert.equal(api.items[0].id, artifact.companies[0].id);
    assert.equal(api.items[0].booth, "A-17");
    assert.equal(api.items[0].revenueRub, 500000000);
    assert.equal(api.items[0].classification, "target");
    for (const forbidden of ["inn", "ogrn", "sourceRecordId", "duplicateSourceRecordIds", "registry", "provenance", "reason"])
      assert.equal(Object.hasOwn(api.items[0], forbidden), false, `${forbidden} is not client-visible`);
    const outputSchema = JSON.parse(await readFile(new URL(`../${s01CatalogSearchCapability.outputSchemaRef}`, import.meta.url)));
    const validate = new Ajv({ strict: false });
    addFormats(validate);
    assert.equal(validate.compile(outputSchema)(api), true, JSON.stringify(validate.errors));

    const calls = (args, version = s01CatalogSearchCapability.version) => mcpServer.receive({ jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: s01CatalogSearchCapability.mcpTool.name, arguments: args, _meta: { capabilityVersion: version } } }).then(JSON.parse);
    assert.equal((await calls({ exhibitionId: "demo-expo-001", profileId: "demo-profile-b" })).error.message, "INVALID_ARGUMENTS");
    assert.equal((await calls({ exhibitionId: "demo-expo-001" }, "8.0.0")).error.message, "CAPABILITY_VERSION_MISMATCH");
  }, { trusted: profile("demo-profile-a", ["crm.companies.read", "crm.catalog.read"]) });
});

test("v1.2 business facts match through catalog HTTP and MCP and satisfy the published output schema", async () => {
  const row = {
    id: "SYNTH001", n: "Synthetic Fact Company", s: "F-12", t: 1, nt: 0, inn: "0000000001", ogrn: null,
    ru: 1, country: "Synthetic Republic", cat: "Synthetic manufacturing", b: "Invented record", seg: "Synthetic",
    rev: 250, ry: 2025, prof: 12, py: 2024, href: "https://example.invalid/fact-company",
    dir: "Synthetic Director", dirpos: "Synthetic Chief Officer", taxesPaidRub: 987654, taxesPaidYear: 2024,
    taxesPaidProvider: "synthetic-fact-source", employeeCount: 38, employeeYear: 2025,
    employeeDefinition: "annual_average", employeeCountProvider: "synthetic-fact-source"
  };
  const projected = projectLegacyExSnapshotV12({ profileRef: "demo-profile-a", eventKey: "demo-expo-facts", entries: [row] });
  assert.equal(projected.status, "projected");
  const SQL = await initSqlJs(), db = new SQL.Database();
  db.run(await readFile(new URL("../migrations/0011_catalog_v12_artifacts.sql", import.meta.url), "utf8"));
  const repository = createCatalogV12D1Repository({
    prepare(sql) { return { bind(...values) {
      const statement = db.prepare(sql);
      statement.bind(values);
      return {
        async first() { try { return statement.step() ? statement.getAsObject() : null; } finally { statement.free(); } },
        async run() { try { statement.step(); return { success: true }; } finally { statement.free(); } }
      };
    } }; }
  });
  for (const corrupt of [
    value => { value.companies[0].enrichment.taxesPaid.provenance.fixtureRef = "stale-source-revision"; },
    value => { value.companies[0].enrichment.employeeCount.period = null; },
    value => { value.companies[0].source.href = "javascript:alert(1)"; }
  ]) {
    const invalid = structuredClone(projected.artifact); corrupt(invalid);
    assert.equal((await repository.saveArtifact({ profileId: "demo-profile-a", artifact: invalid })).status, "invalid_artifact");
  }
  assert.equal((await importLegacyExSnapshotV12({ repository, profileRef: "demo-profile-a",
    eventKey: "demo-expo-facts", entries: [row] })).status, "stored");
  const trusted = () => profile("demo-profile-a", ["crm.catalog.read"]);
  const catalogSearchHandler = createCatalogV11SearchHandler({ repository, resolveTrustedProfile: trusted });
  const http = createServer({ resolveTrustedProfile: trusted,
    dealIntents: { visibleCompanies: () => [] }, catalogV11Repository: repository,
    resolveCatalogV11TrustedProfile: trusted });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${http.address().port}`;
  const mcpServer = createOfflineS01McpServer({ dealIntents: { visibleCompanies: () => [] },
    resolveTrustedProfile: trusted, catalogSearchHandler });
  try {
    const apiResponse = await fetch(`${base}/api/v1/catalogs/demo-expo-facts/entries`, {
      headers: { "x-test-profile": "demo-profile-a", "x-test-scopes": "crm.catalog.read" }
    });
    assert.equal(apiResponse.status, 200);
    const api = await apiResponse.json();
    const mcp = await createOfflineS01McpClient(mcpServer).searchCatalog({ exhibitionId: "demo-expo-facts" });
    assert.deepEqual(mcp, api);
    const schema = JSON.parse(await readFile(new URL(`../${s01CatalogSearchCapability.outputSchemaRef}`, import.meta.url)));
    const validate = new Ajv({ strict: true }); addFormats(validate);
    assert.equal(validate.compile(schema)(api), true, JSON.stringify(validate.errors));
    assert.equal(api.artifactVersion, "1.2.0");
    assert.equal(api.items[0].taxesPaidRub, 987654);
    assert.equal(api.items[0].employeeCount, 38);
    assert.equal(api.items[0].directorName, "Synthetic Director");
    assert.equal(api.items[0].taxesPaidProvenance.fixtureRef, api.sourceRevision);
  } finally { await new Promise((resolve, reject) => http.close((error) => error ? reject(error) : resolve())); }
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
