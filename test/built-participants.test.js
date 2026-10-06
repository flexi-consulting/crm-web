import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Ajv from "ajv/dist/2020.js";
import { createServer } from "../src/server.js";
import { createCatalogBuildService } from "../src/catalog-build.js";
import { createOfflineBuiltCatalogMcp } from "../src/offline-built-catalog-mcp.js";

const scope = "crm.catalog.build.read.synthetic";
const context = (profileId, scopes = [scope]) => ({ profileId, scopes });
async function withFixture(run, resolveTrustedProfile = () => context("demo-profile-a")) {
  const catalogBuilds = createCatalogBuildService();
  const server = createServer({ catalogBuilds, resolveTrustedProfile });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run({ base, catalogBuilds, mcp: createOfflineBuiltCatalogMcp({ catalogBuilds, resolveTrustedProfile }) }); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}
const mcpCall = async (mcp, args) => JSON.parse(await mcp.receive({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "crm_built_catalog_participants_read", arguments: args, _meta: { capabilityVersion: "1.1.0" } } }));

test("S-02 validated build becomes S-01 participant list/card with one stable object reference", async () => {
  await withFixture(async ({ base, catalogBuilds, mcp }) => {
    const built = await catalogBuilds.build({ profileId: "demo-profile-a", idempotencyKey: "built-participants-01", exhibitionId: "demo-expo-001" });
    assert.equal(built.status, 201);
    const buildId = built.body.buildId;
    const url = `${base}/api/v1/catalog-builds/${buildId}/participants`;
    const api = await fetch(url).then((response) => response.json());
    assert.equal(api.buildId, buildId);
    assert.equal(api.sourceRevision, "fixture-expo-001-r1");
    assert.deepEqual(api.items.map((item) => item.qualification.classification).sort(), ["near_target", "near_target", "not_target", "target"]);
    assert.deepEqual(api.items.map((item) => item.id), built.body.artifact.companies.map((item) => item.id));
    const target = api.items.find((item) => item.qualification.classification === "target");
    assert.equal(target.name, "Example Machine Works");
    assert.equal(target.source.booth, "A-01");
    assert.equal(target.enrichment.provenance.provider, "synthetic-enrichment");
    assert.equal(target.registry.status, "ok");
    const card = await fetch(`${base}${target.detailPath}`).then((response) => response.json());
    assert.deepEqual(card.items, [target]);
    const search = await fetch(`${url}?q=machine&classification=target`).then((response) => response.json());
    assert.deepEqual(search.items, [target]);
    const rpc = await mcpCall(mcp, { buildId, q: "machine", classification: "target" });
    assert.deepEqual(rpc.result.structuredContent, search);
    assert.equal(rpc.result.content[0].text, JSON.stringify(search));
    const descriptor = JSON.parse(await readFile(new URL("../capabilities/s02-built-participants.v1.json", import.meta.url)));
    assert.equal(descriptor.version, "1.1.0");
    const schema = JSON.parse(await readFile(new URL(`../${descriptor.outputSchemaRef}`, import.meta.url)));
    const validate = new Ajv().compile(schema);
    assert.ok(validate(api), JSON.stringify(validate.errors));
  });
});

test("build participant reads fail closed across profiles, missing scope and invalid filters", async () => {
  await withFixture(async ({ base, catalogBuilds, mcp }) => {
    const built = await catalogBuilds.build({ profileId: "demo-profile-b", idempotencyKey: "built-participants-b", exhibitionId: "demo-expo-001" });
    const path = `/api/v1/catalog-builds/${built.body.buildId}/participants`;
    assert.equal((await fetch(`${base}${path}`)).status, 404);
    assert.equal((await mcpCall(mcp, { buildId: built.body.buildId })).error.message, "BUILD_NOT_FOUND");
    assert.equal((await fetch(`${base}${path}?q=one&q=two`)).status, 400);
    assert.equal((await fetch(`${base}${path}?classification=unsafe`)).status, 400);
    assert.equal((await fetch(`${base}${path}/co-${"0".repeat(20)}`)).status, 404);
    assert.equal((await mcpCall(mcp, { buildId: built.body.buildId, profileId: "demo-profile-b" })).error.message, "INVALID_ARGUMENTS");
  });
  await withFixture(async ({ base, catalogBuilds, mcp }) => {
    const built = await catalogBuilds.build({ profileId: "demo-profile-a", idempotencyKey: "built-participants-denied", exhibitionId: "demo-expo-001" });
    assert.equal((await fetch(`${base}/api/v1/catalog-builds/${built.body.buildId}/participants`)).status, 403);
    assert.equal((await mcpCall(mcp, { buildId: built.body.buildId })).error.message, "SCOPE_DENIED");
  }, () => context("demo-profile-a", []));
});

test("offline descriptor is bound to the same domain method and absent from production manifest", async () => {
  const descriptor = JSON.parse(await readFile(new URL("../capabilities/s02-built-participants.v1.json", import.meta.url)));
  assert.equal(descriptor.handlerBinding, "src/catalog-build.js#createCatalogBuildService.readParticipants");
  assert.equal(descriptor.publication, "offline_test_only");
  await withFixture(async ({ base, mcp }) => {
    const manifest = await fetch(`${base}/api/v1/manifest`).then((response) => response.json());
    assert.equal(manifest.capabilities.some((capability) => capability.id === descriptor.capabilityId), false);
    assert.equal((JSON.parse(await mcp.receive({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }))).result.protocolVersion, "2025-06-18");
    const listed = JSON.parse(await mcp.receive({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }));
    assert.equal(listed.result.tools[0]._meta.capabilityId, descriptor.capabilityId);
  });
  for (const file of ["../src/catalog-build.js", "../src/offline-built-catalog-mcp.js"]) {
    assert.doesNotMatch(await readFile(new URL(file, import.meta.url), "utf8"), /runner\.launch|spawnAgentRun|agent-run/i);
  }
});
