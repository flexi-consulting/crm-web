import test from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv/dist/2020.js";
import { readFile } from "node:fs/promises";
import { createServer } from "../src/server.js";
import { createCatalogBuildService, createSyntheticSourceAdapter, createSyntheticEnrichmentAdapter, createSyntheticRegistryAdapter, normalizeEnrichment, normalizeRegistry, qualify } from "../src/catalog-build.js";

const scopes = ["crm.catalog.build.synthetic", "crm.catalog.build.read.synthetic"];
const headers = (profileId, granted = scopes) => ({ "x-test-profile": profileId, "x-test-scopes": granted.join(" ") });

async function withServer(run, { sourceAdapter, enrichmentAdapter, registryAdapter, sources } = {}) {
  const catalogBuilds = createCatalogBuildService({ sourceAdapter, enrichmentAdapter, registryAdapter, sources });
  const server = createServer({ catalogBuilds, resolveTrustedProfile: (request) => ({ profileId: request.headers["x-test-profile"], scopes: (request.headers["x-test-scopes"] ?? "").split(" ").filter(Boolean) }) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise((resolve, reject) => server.close((e) => e ? reject(e) : resolve())); }
}

async function postBuild(base, profile, idempotencyKey, exhibitionId = "demo-expo-001", granted = scopes) {
  return fetch(`${base}/api/v1/catalog-builds`, {
    method: "POST",
    headers: { ...headers(profile, granted), "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: JSON.stringify({ exhibitionId })
  });
}

async function validators(...names) {
  const ajv = new Ajv();
  for (const name of names) ajv.addSchema(JSON.parse(await readFile(new URL(`../schemas/${name}.schema.json`, import.meta.url))));
  return Object.fromEntries(names.map((name) => [name, ajv.getSchema(`https://crm-web.example.invalid/schemas/${name}.schema.json`)]));
}

test("synthetic build imports, deduplicates, enriches, qualifies, and reconciles report counts", async () => {
  await withServer(async (base) => {
    const response = await postBuild(base, "demo-profile-a", "catalog-build-key-01");
    assert.equal(response.status, 201);
    const body = await response.json();
    const { "catalog-build-request": requestSchema, "catalog-build-response": responseSchema } = await validators("catalog-build-request", "catalog-build-response", "catalog-build-artifact", "catalog-build-report", "catalog-build-error");
    assert.equal(requestSchema({ exhibitionId: "demo-expo-001" }), true);
    assert.equal(requestSchema({ exhibitionId: "demo-expo-001", profileId: "demo-profile-a" }), false);
    assert.equal(responseSchema(body), true);
    assert.equal(body.report.validation.valid, true);
    assert.deepEqual(body.report.validation.counts, {
      sourceRecords: 5, uniqueCompanies: 4, duplicateRecords: 1,
      enrichmentFound: 3, enrichmentNotFound: 0, enrichmentUnavailable: 1,
      registryOk: 1, registryUnknown: 1, registrySanctioned: 1, registryNotFound: 0, registryInactive: 1,
      targets: 1, nearTargets: 2, notTargets: 1
    });
    const companies = body.artifact.companies;
    assert.equal(companies.length, 4);
    assert.equal(companies.find((c) => c.source.sourceRecordId === "src-demo-001").source.duplicateSourceRecordIds[0], "src-demo-002");
    const unknownRegistry = companies.find((c) => c.source.sourceRecordId === "src-demo-003");
    assert.equal(unknownRegistry.registry.status, "unknown");
    assert.equal(unknownRegistry.qualification.target, false);
    const sanctioned = companies.find((c) => c.source.sourceRecordId === "src-demo-005");
    assert.equal(sanctioned.registry.status, "sanctioned");
    assert.equal(sanctioned.qualification.target, false);
    assert.equal(sanctioned.qualification.classification, "not_target");
    assert.equal(body.report.stages.enrichment.status, "partial");
    assert.equal(body.report.stages.registry.status, "partial");
    const fetched = await fetch(`${base}/api/v1/catalog-builds/${body.buildId}`, { headers: headers("demo-profile-a") });
    assert.equal(fetched.status, 200);
    assert.deepEqual((await fetched.json()).artifact, body.artifact);
  });
});

test("build artifacts and reports are deterministic; same key replays without another adapter call", async () => {
  let sourceCalls = 0, enrichCalls = 0, registryCalls = 0;
  const sourceFixtures = createSyntheticSourceAdapter();
  const enrichmentFixtures = createSyntheticEnrichmentAdapter();
  const registryFixtures = createSyntheticRegistryAdapter();
  const sourceAdapter = { async load(id) { sourceCalls++; return sourceFixtures.load(id); } };
  const enrichmentAdapter = { async enrich(record) { enrichCalls++; return enrichmentFixtures.enrich(record); } };
  const registryAdapter = { async check(record) { registryCalls++; return registryFixtures.check(record); } };
  await withServer(async (base) => {
    const first = await (await postBuild(base, "demo-profile-a", "catalog-build-key-02")).json();
    const replayResponse = await postBuild(base, "demo-profile-a", "catalog-build-key-02");
    assert.equal(replayResponse.status, 200);
    const replay = await replayResponse.json();
    assert.equal(replay.replayed, true);
    assert.equal(replay.buildId, first.buildId);
    assert.deepEqual(replay.artifact, first.artifact);
    assert.deepEqual(replay.report, first.report);

    const anotherKey = await (await postBuild(base, "demo-profile-a", "catalog-build-key-03")).json();
    assert.deepEqual(anotherKey.artifact, first.artifact);
    assert.deepEqual(anotherKey.report, first.report);
    assert.equal(sourceCalls, 2);
    assert.equal(enrichCalls, 8);
    assert.equal(registryCalls, 6);
  }, { sourceAdapter, enrichmentAdapter, registryAdapter });
});

test("concurrent duplicate submissions share one in-flight build", async () => {
  let sourceCalls = 0;
  const sourceFixtures = createSyntheticSourceAdapter();
  await withServer(async (base) => {
    const requests = await Promise.all([
      postBuild(base, "demo-profile-a", "catalog-build-key-concurrent"),
      postBuild(base, "demo-profile-a", "catalog-build-key-concurrent")
    ]);
    assert.deepEqual(requests.map((r) => r.status).sort(), [200, 201]);
    const bodies = await Promise.all(requests.map((r) => r.json()));
    assert.equal(bodies[0].buildId, bodies[1].buildId);
    assert.equal(bodies.filter((b) => b.replayed).length, 1);
    assert.equal(sourceCalls, 1);
  }, { sourceAdapter: { async load(id) { sourceCalls++; await new Promise((resolve) => setTimeout(resolve, 10)); return sourceFixtures.load(id); } } });
});

test("missing or invalid source prerequisites stop before enrichment and registry calls", async () => {
  let sourceCalls = 0, enrichCalls = 0, registryCalls = 0;
  const sourceAdapter = { async load(id) { sourceCalls++; return id === "demo-expo-002" ? { sourceRevision: "fixture-empty", records: [] } : { sourceRevision: "fixture-invalid", records: [{ sourceRecordId: "unsafe/../id", name: "Synthetic", country: "RU" }] }; } };
  const enrichmentAdapter = { async enrich() { enrichCalls++; return {}; } };
  const registryAdapter = { async check() { registryCalls++; return {}; } };
  await withServer(async (base) => {
    const missing = await postBuild(base, "demo-profile-a", "catalog-build-key-04", "demo-expo-999");
    assert.equal(missing.status, 404);
    const empty = await postBuild(base, "demo-profile-a", "catalog-build-key-empty", "demo-expo-002");
    assert.equal(empty.status, 422);
    assert.equal((await empty.json()).code, "BUILD_SOURCE_INVALID");
    const invalid = await postBuild(base, "demo-profile-a", "catalog-build-key-05");
    assert.equal(invalid.status, 422);
    assert.equal((await invalid.json()).code, "BUILD_SOURCE_INVALID");
    assert.equal(sourceCalls, 2);
    assert.equal(enrichCalls, 0);
    assert.equal(registryCalls, 0);
  }, { sourceAdapter, enrichmentAdapter, registryAdapter });
});

test("duplicate source IDs block the build before downstream provider calls", async () => {
  let enrichCalls = 0, registryCalls = 0;
  const sources = { "demo-expo-001": { sourceRevision: "fixture-dup", records: [] } };
  const sourceAdapter = { async load() { return { sourceRevision: "fixture-dup", records: [
    { sourceRecordId: "src-duplicate", name: "Synthetic One", country: "RU" },
    { sourceRecordId: "src-duplicate", name: "Synthetic Two", country: "RU" }
  ] }; } };
  await withServer(async (base) => {
    const response = await postBuild(base, "demo-profile-a", "catalog-build-key-06");
    assert.equal(response.status, 422);
    assert.equal((await response.json()).code, "BUILD_DUPLICATE_SOURCE_ID");
    assert.equal(enrichCalls, 0);
    assert.equal(registryCalls, 0);
  }, { sources, sourceAdapter, enrichmentAdapter: { async enrich() { enrichCalls++; } }, registryAdapter: { async check() { registryCalls++; } } });
});

test("provider failures are typed and preserved as partial unknown results", async () => {
  await withServer(async (base) => {
    const body = await (await postBuild(base, "demo-profile-a", "catalog-build-key-07")).json();
    const unavailable = body.artifact.companies.find((c) => c.enrichment.status === "unavailable");
    assert.ok(unavailable);
    assert.equal(unavailable.enrichment.inn, null);
    assert.equal(unavailable.registry.status, "unknown");
    assert.deepEqual(body.report.providerErrors, [
      { stage: "enrichment", sourceRecordId: "src-demo-001", code: "ENRICHMENT_UNAVAILABLE" },
      { stage: "enrichment", sourceRecordId: "src-demo-003", code: "ENRICHMENT_UNAVAILABLE" },
      { stage: "enrichment", sourceRecordId: "src-demo-004", code: "ENRICHMENT_UNAVAILABLE" },
      { stage: "enrichment", sourceRecordId: "src-demo-005", code: "ENRICHMENT_UNAVAILABLE" }
    ]);
    assert.equal(body.report.validation.valid, true);
  }, {
    enrichmentAdapter: { async enrich() { throw new Error("private provider message"); } },
    registryAdapter: { async check() { throw new Error("private provider message"); } }
  });
});

test("not_found and unavailable enrichment discard contradictory target data and cannot qualify", async () => {
  const targetData = { inn: "0000000001", ogrn: "0000000000001", revenueRub: 500000000, activity: "manufacturer", website: "https://example.invalid/company", provenance: { provider: "synthetic", fixtureRef: "contradictory-response" } };
  for (const status of ["not_found", "unavailable"]) {
    const enrichment = normalizeEnrichment({ ...targetData, status });
    assert.equal(enrichment.status, status);
    assert.equal(enrichment.inn, null);
    assert.equal(enrichment.ogrn, null);
    assert.equal(enrichment.revenueRub, null);
    const qualification = qualify({ source: { country: "RU" }, enrichment, registry: { status: "ok" } });
    assert.equal(qualification.target, false);
  }
  assert.equal(normalizeEnrichment({ ...targetData, status: "found", revenueRub: -1 }), null);

  const source = { sourceRevision: "fixture-contradictory", records: [
    { sourceRecordId: "src-contradict-1", name: "Synthetic Missing", country: "RU" },
    { sourceRecordId: "src-contradict-2", name: "Synthetic Unavailable", country: "RU" }
  ] };
  const sources = { "demo-expo-001": source };
  await withServer(async (base) => {
    const body = await (await postBuild(base, "demo-profile-a", "catalog-build-key-contradiction")).json();
    for (const company of body.artifact.companies) {
      assert.equal(company.enrichment.inn, null);
      assert.equal(company.enrichment.revenueRub, null);
      assert.equal(company.registry.status, "unknown");
      assert.equal(company.qualification.target, false);
    }
  }, { sources, sourceAdapter: { async load() { return source; } }, enrichmentAdapter: { async enrich(record) { return { ...targetData, status: record.sourceRecordId.endsWith("1") ? "not_found" : "unavailable" }; } }, registryAdapter: { async check() { throw new Error("should not be called without validated identity"); } } });
});

test("unsafe source href and empty provenance identifiers fail closed", async () => {
  let enrichCalls = 0;
  const source = { sourceRevision: "fixture-unsafe-href", records: [{ sourceRecordId: "src-unsafe-href", name: "Synthetic Unsafe Link", country: "RU", href: "javascript:alert(1)" }] };
  const sources = { "demo-expo-001": source };
  await withServer(async (base) => {
    const response = await postBuild(base, "demo-profile-a", "catalog-build-key-unsafe-href");
    assert.equal(response.status, 422);
    assert.equal((await response.json()).code, "BUILD_SOURCE_INVALID");
    assert.equal(enrichCalls, 0);
  }, { sources, sourceAdapter: { async load() { return source; } }, enrichmentAdapter: { async enrich() { enrichCalls++; } } });

  assert.equal(normalizeEnrichment({ status: "found", inn: "0000000001", provenance: { provider: " ", fixtureRef: "ref" } }), null);
  assert.equal(normalizeEnrichment({ status: "found", inn: "0000000001", provenance: { provider: "provider", fixtureRef: " " } }), null);
  assert.equal(normalizeRegistry({ status: "ok", source: " ", fixtureRef: "ref" }), null);
  assert.equal(normalizeRegistry({ status: "ok", source: "registry", fixtureRef: " " }), null);
});

test("registry adapter failure is recorded as unknown with provenance, not as ok", async () => {
  const enrichment = createSyntheticEnrichmentAdapter();
  await withServer(async (base) => {
    const body = await (await postBuild(base, "demo-profile-a", "catalog-build-key-10")).json();
    const company = body.artifact.companies.find((c) => c.source.sourceRecordId === "src-demo-001");
    assert.equal(company.registry.status, "unknown");
    assert.equal(company.registry.provenance.fixtureRef, "provider-unavailable");
    assert.equal(company.qualification.target, false);
    assert.equal(body.report.providerErrors.some((item) => item.code === "REGISTRY_UNAVAILABLE" && item.sourceRecordId === "src-demo-001"), true);
  }, { enrichmentAdapter: enrichment, registryAdapter: { async check() { throw new Error("private registry response"); } } });
});

test("build reads are profile isolated, scoped, and absent from capability discovery", async () => {
  await withServer(async (base) => {
    const created = await (await postBuild(base, "demo-profile-a", "catalog-build-key-08")).json();
    const foreign = await fetch(`${base}/api/v1/catalog-builds/${created.buildId}`, { headers: headers("demo-profile-b") });
    assert.equal(foreign.status, 404);
    const denied = await postBuild(base, "demo-profile-a", "catalog-build-key-09", "demo-expo-001", []);
    assert.equal(denied.status, 403);
    const manifest = await (await fetch(`${base}/api/v1/manifest`)).json();
    assert.equal(manifest.capabilities.some((capability) => capability.id.includes("catalog.build")), false);
  });
});
