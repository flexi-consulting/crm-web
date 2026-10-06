import test from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv/dist/2020.js";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "../src/server.js";
import { createCatalogBuildService, createSyntheticSourceAdapter, createSyntheticEnrichmentAdapter, createSyntheticRegistryAdapter, normalizeEnrichment, normalizeRegistry, qualify } from "../src/catalog-build.js";
import { renderCatalogPreview } from "../src/catalog-preview.js";
import { queryCatalogV11, renderCatalogV11, createCatalogV11ReadHandler,
  createCatalogV11D1Repository } from "../src/catalog-query-v11.js";
import initSqlJs from "sql.js";

const scopes = ["crm.catalog.build.synthetic", "crm.catalog.build.read.synthetic", "crm.catalog.preview.synthetic", "crm.catalog.preview.read.synthetic"];
const headers = (profileId, granted = scopes) => ({ "x-test-profile": profileId, "x-test-scopes": granted.join(" ") });

async function withServer(run, { sourceAdapter, enrichmentAdapter, registryAdapter, sources, catalogBuilds, trusted = true } = {}) {
  catalogBuilds ??= createCatalogBuildService({ sourceAdapter, enrichmentAdapter, registryAdapter, sources });
  const server = createServer({ catalogBuilds, ...(trusted ? { resolveTrustedProfile: (request) => ({ profileId: request.headers["x-test-profile"], scopes: (request.headers["x-test-scopes"] ?? "").split(" ").filter(Boolean) }) } : {}) });
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

test("S-01 v1.1 metadata schema preserves synthetic legacy filter fields with explicit units and nullable years", async () => {
  const ajv = new Ajv({ strict: false });
  const schema = JSON.parse(await readFile(new URL("../schemas/catalog-build-artifact-v1.1.schema.json", import.meta.url)));
  const validate = ajv.compile(schema);
  const company = {
    id: "co-0123456789abcdef0123", name: "Synthetic Boundary Maker",
    source: { sourceRecordId: "src-synthetic-boundary", country: "Fictionland", booth: null,
      href: "https://example.invalid/synthetic", category: "Synthetic category",
      description: "Synthetic source description", segment: "synthetic segment", duplicateSourceRecordIds: [] },
    enrichment: { status: "found", inn: "0000000001", ogrn: null, revenueRub: 100_000_000,
      revenueYear: 2025, profitRub: -1, profitYear: 2024, activity: "unknown",
      website: null, provenance: { provider: "legacy-ex-snapshot", fixtureRef: "synthetic-source-row-01" } },
    registry: { status: "unknown", provenance: { source: "synthetic-registry", fixtureRef: "synthetic-registry-01" } },
    qualification: { classification: "unknown", target: false, nearTarget: false,
      reason: "legacy_classification_unverified" }
  };
  const artifact = { schemaVersion: "1.1.0", exhibitionId: "synthetic-current-source-shape",
    sourceRevision: "synthetic-source-revision-01", companies: [company] };
  assert.equal(validate(artifact), true, JSON.stringify(validate.errors));
  const withoutFinancialYear = structuredClone(artifact);
  withoutFinancialYear.companies[0].enrichment.revenueYear = null;
  withoutFinancialYear.companies[0].enrichment.profitRub = null;
  withoutFinancialYear.companies[0].enrichment.profitYear = null;
  assert.equal(validate(withoutFinancialYear), true, JSON.stringify(validate.errors));
  const wrongUnit = structuredClone(artifact);
  wrongUnit.companies[0].enrichment.profitRub = 0.5;
  assert.equal(validate(wrongUnit), false, "money uses integer whole-RUB storage");
  const unknownYear = structuredClone(artifact);
  unknownYear.companies[0].enrichment.profitYear = 1899;
  assert.equal(validate(unknownYear), false, "years stay in the documented bounded domain");
  const leakedField = structuredClone(artifact);
  leakedField.companies[0].source.email = "synthetic@example.invalid";
  assert.equal(validate(leakedField), false, "schema remains allowlist based");

  const rows = [
    { ...structuredClone(company), name: "Below Revenue", enrichment: { ...company.enrichment, revenueRub: 99_999_999, profitRub: -1 }, source: { ...company.source, category: "Synthetic apparel" } },
    { ...structuredClone(company), id: "co-1123456789abcdef0123", name: "Revenue Boundary", enrichment: { ...company.enrichment, revenueRub: 100_000_000, profitRub: 0 }, source: { ...company.source, country: "RU", category: "Synthetic lingerie" } },
    { ...structuredClone(company), id: "co-2123456789abcdef0123", name: "Revenue Upper Boundary", enrichment: { ...company.enrichment, revenueRub: 1_500_000_000, profitRub: 30_000_000 } },
    { ...structuredClone(company), id: "co-3123456789abcdef0123", name: "Revenue Above", enrichment: { ...company.enrichment, revenueRub: 1_500_000_001, profitRub: 200_000_000 } },
    { ...structuredClone(company), id: "co-4123456789abcdef0123", name: "Unknown Finance", enrichment: { ...company.enrichment, revenueRub: null, profitRub: null } }
  ];
  const queryArtifact = { ...artifact, companies: rows };
  const names = args => queryCatalogV11(queryArtifact, args).items.map(row => row.name).sort();
  assert.deepEqual(names({ revenueBand: "0-100" }), ["Below Revenue"]);
  assert.deepEqual(names({ revenueBand: "100-1500" }), ["Revenue Boundary", "Revenue Upper Boundary"]);
  assert.deepEqual(names({ revenueBand: "1500+" }), ["Revenue Above"]);
  assert.deepEqual(names({ profitBand: "loss" }), ["Below Revenue"]);
  assert.deepEqual(names({ profitBand: "0-30" }), ["Revenue Boundary"]);
  assert.deepEqual(names({ profitBand: "30-200" }), ["Revenue Upper Boundary"]);
  assert.deepEqual(names({ profitBand: "200+" }), ["Revenue Above"]);
  assert.deepEqual(names({ query: "apparel" }), ["Below Revenue"]);
  assert.deepEqual(names({ country: "fictionland" }), ["Below Revenue", "Revenue Above", "Revenue Upper Boundary", "Unknown Finance"]);
  assert.deepEqual(names({ country: "RU", classification: "unknown" }), ["Revenue Boundary"]);
  assert.deepEqual(queryCatalogV11(artifact, { revenueBand: "unsafe" }), { status: "invalid_query" });
  const filtered = queryCatalogV11(queryArtifact, { revenueBand: "100-1500", profitBand: "30-200" });
  const view = renderCatalogV11({ artifact: queryArtifact, result: filtered,
    filters: { revenueBand: "100-1500", profitBand: "30-200" } });
  assert.equal(view.status, "ok");
  assert.match(view.html, /<option value="100-1500" selected>/);
  assert.match(view.html, /<option value="30-200" selected>/);
  assert.match(view.html, /Найдено: 1/);
  const hostile = structuredClone(queryArtifact);
  hostile.companies = [{ ...structuredClone(company), name: '<img src=x onerror="bad">',
    source: { ...company.source, category: "<script>bad</script>", description: "<b>bad</b>",
      href: "https://example.invalid/a\\\" onmouseover=bad" } }];
  const safeView = renderCatalogV11({ artifact: hostile, result: queryCatalogV11(hostile), filters: {} });
  assert.equal(safeView.html.includes("<img src=x"), false);
  assert.equal(safeView.html.includes("<script>bad</script>"), false);
  assert.equal(safeView.html.includes('onmouseover=bad'), false);

  const calls = [];
  const handler = createCatalogV11ReadHandler({
    repository: { async getArtifact(scope) {
      calls.push(scope);
      return scope.profileId === "demo-profile-a" ? queryArtifact : null;
    } },
    resolveTrustedProfile: async request => request.headers.get("x-test-profile") === "unavailable"
      ? (() => { throw new Error("identity unavailable"); })()
      : ({ profileId: request.headers.get("x-test-profile"), scopes: request.headers.get("x-test-scope")?.split(" ") ?? [] })
  });
  const fetchHandler = (profileId, scope = "crm.catalog.read", path = "/catalogs/synthetic-current-source-shape?revenueBand=100-1500&profitBand=30-200") =>
    handler(new Request(`https://crm.example.invalid${path}`, { headers: { "x-test-profile": profileId, "x-test-scope": scope } }));
  assert.equal((await fetchHandler("demo-profile-a")).status, 200);
  assert.equal((await fetchHandler("demo-profile-a", "")).status, 403);
  assert.equal((await fetchHandler("demo-profile-b")).status, 404);
  assert.equal((await fetchHandler("unavailable")).status, 503);
  assert.equal((await fetchHandler("demo-profile-a", "crm.catalog.read", "/catalogs/synthetic-current-source-shape?revenueBand=unsafe")).status, 400);
  assert.equal((await fetchHandler("demo-profile-a", "crm.catalog.read", "/catalogs/synthetic-current-source-shape?query=a&query=b")).status, 400);
  assert.ok(calls.every(scope => scope.profileId !== "demo-profile-b" || scope.exhibitionId === "synthetic-current-source-shape"));
});

test("S-01 v1.1 D1 repository persists durable profile-scoped artifacts and verifies content hash", async () => {
  class D1Statement {
    constructor(db, sql, values = []) { this.db = db; this.sql = sql; this.values = values; }
    bind(...values) { return new D1Statement(this.db, this.sql, values); }
    async first() {
      const statement = this.db.prepare(this.sql);
      try { statement.bind(this.values); return statement.step() ? statement.getAsObject() : null; }
      finally { statement.free(); }
    }
    async run() { this.db.run(this.sql, this.values); return { meta: { changes: this.db.getRowsModified() } }; }
  }
  class LocalD1 { constructor(db) { this.db = db; } prepare(sql) { return new D1Statement(this.db, sql); } }
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(await readFile(new URL("../migrations/0005_catalog_v11_artifacts.sql", import.meta.url), "utf8"));
  const repo = createCatalogV11D1Repository(new LocalD1(db), () => "2026-10-06T00:00:00.000Z");
  const artifact = { schemaVersion: "1.1.0", exhibitionId: "synthetic-current-source-shape",
    sourceRevision: "synthetic-revision-1", companies: [{ id: "co-0123456789abcdef0123", name: "Synthetic durable row",
      source: { sourceRecordId: "src-synthetic-durable", country: "Fictionland", booth: null, href: null,
        category: "Synthetic category", description: null, segment: null, duplicateSourceRecordIds: [] },
      enrichment: { status: "not_found", inn: null, ogrn: null, revenueRub: null, revenueYear: null,
        profitRub: null, profitYear: null, activity: "unknown", website: null,
        provenance: { provider: "synthetic", fixtureRef: "synthetic-durable" } },
      registry: { status: "unknown", provenance: { source: "synthetic", fixtureRef: "synthetic-durable" } },
      qualification: { classification: "unknown", target: false, nearTarget: false, reason: "synthetic_unverified" } }] };
  assert.equal((await repo.saveArtifact({ profileId: "demo-profile-a",
    artifact: { ...artifact, companies: [{ id: "co-0123456789abcdef0123", name: "incomplete" }] } })).status,
  "invalid_artifact");
  assert.equal((await repo.saveArtifact({ profileId: "demo-profile-a", artifact })).status, "stored");
  assert.equal((await repo.saveArtifact({ profileId: "demo-profile-a", artifact })).status, "replay");
  assert.deepEqual(await repo.getArtifact({ profileId: "demo-profile-a", exhibitionId: artifact.exhibitionId }), artifact);
  assert.equal(await repo.getArtifact({ profileId: "demo-profile-b", exhibitionId: artifact.exhibitionId }), null);
  const revisionTwo = { ...artifact, sourceRevision: "synthetic-revision-2" };
  assert.equal((await repo.saveArtifact({ profileId: "demo-profile-a", artifact: revisionTwo })).status, "stored");
  assert.equal((await repo.getArtifact({ profileId: "demo-profile-a", exhibitionId: artifact.exhibitionId })).sourceRevision,
    "synthetic-revision-2");
  const persistedHandler = createCatalogV11ReadHandler({ repository: repo,
    resolveTrustedProfile: async () => ({ profileId: "demo-profile-a", scopes: ["crm.catalog.read"] }) });
  const page = await persistedHandler(new Request(`https://crm.example.invalid/catalogs/${artifact.exhibitionId}`));
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Synthetic durable row/);
  const server = createServer({ catalogV11Repository: repo,
    resolveCatalogV11TrustedProfile: async () => ({ profileId: "demo-profile-a", scopes: ["crm.catalog.read"] }) });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const transported = await fetch(`http://127.0.0.1:${address.port}/catalogs/${artifact.exhibitionId}`);
    assert.equal(transported.status, 200);
    assert.match(transported.headers.get("content-type"), /text\/html/);
    assert.match(await transported.text(), /Synthetic durable row/);
  } finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  db.run("UPDATE crm_catalog_v11_artifacts SET artifact_json=? WHERE profile_ref=?",
    [JSON.stringify({ ...revisionTwo, sourceRevision: "forged" }), "demo-profile-a"]);
  assert.equal(await repo.getArtifact({ profileId: "demo-profile-a", exhibitionId: artifact.exhibitionId }), null);
  const malformedJson = JSON.stringify({ ...revisionTwo, companies: [{ id: "co-0123456789abcdef0123", name: "incomplete" }] });
  const malformedSha = createHash("sha256").update(malformedJson).digest("hex");
  db.run("UPDATE crm_catalog_v11_artifacts SET artifact_json=?,content_sha=? WHERE profile_ref=?",
    [malformedJson, malformedSha, "demo-profile-a"]);
  assert.equal(await repo.getArtifact({ profileId: "demo-profile-a", exhibitionId: artifact.exhibitionId }), null);
  db.close();
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

test("preview renders required catalog sections, cards, links, filters, badges, and build provenance", async () => {
  let sourceCalls = 0, enrichmentCalls = 0, registryCalls = 0;
  const sourceFixtures = createSyntheticSourceAdapter(), enrichmentFixtures = createSyntheticEnrichmentAdapter(), registryFixtures = createSyntheticRegistryAdapter();
  await withServer(async (base) => {
    const buildResponse = await postBuild(base, "demo-profile-a", "preview-source-build-01");
    const build = await buildResponse.json();
    const callsBeforePreview = [sourceCalls, enrichmentCalls, registryCalls];
    const previewResponse = await fetch(`${base}/api/v1/catalog-builds/${build.buildId}/preview`, { method: "POST", headers: headers("demo-profile-a") });
    assert.equal(previewResponse.status, 201);
    const descriptor = await previewResponse.json();
    const { "catalog-preview-response": descriptorSchema } = await validators("catalog-preview-response", "catalog-preview-report", "catalog-preview-error");
    assert.equal(descriptorSchema(descriptor), true);
    assert.equal(descriptor.buildId, build.buildId);
    assert.equal(descriptor.sourceRevision, build.artifact.sourceRevision);
    assert.equal(descriptor.report.valid, true);
    assert.equal(descriptor.report.published, false);

    const pageResponse = await fetch(`${base}${descriptor.url}`, { headers: headers("demo-profile-a") });
    assert.equal(pageResponse.status, 200);
    assert.match(pageResponse.headers.get("content-security-policy"), /connect-src 'none'/);
    const html = await pageResponse.text();
    for (const token of ["data-preview-only=\"true\"", "id=\"searchInput\"", "data-filter=\"target\"", "data-filter=\"near\"", "data-filter=\"not-target\"", "data-filter=\"registry-review\"", "id=\"alphaNav\"", "id=\"catalog\"", "class=\"company-card", "class=\"target-badge\"", "class=\"near-badge\"", "class=\"not-target-badge\"", "class=\"enrichment-badge", "class=\"registry-badge", "class=\"card-link profile-link\"", "class=\"card-link website-link\""]) assert.ok(html.includes(token), `missing ${token}`);
    const inlineScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(inlineScript);
    assert.doesNotThrow(() => new vm.Script(inlineScript));
    assert.ok(html.includes(build.buildId));
    assert.ok(html.includes(build.artifact.sourceRevision));
    assert.equal(html.includes("NOTES_API"), false);
    assert.equal(html.includes("getUserMedia"), false);
    assert.equal(html.includes("t.me/"), false);
    assert.deepEqual([sourceCalls, enrichmentCalls, registryCalls], callsBeforePreview);

    const replay = await fetch(`${base}/api/v1/catalog-builds/${build.buildId}/preview`, { method: "POST", headers: headers("demo-profile-a") });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).previewId, descriptor.previewId);
    const replayPage = await fetch(`${base}${descriptor.url}`, { headers: headers("demo-profile-a") });
    assert.equal(await replayPage.text(), html);
    const manifest = await (await fetch(`${base}/api/v1/manifest`)).json();
    assert.equal(manifest.capabilities.some((capability) => capability.id.includes("catalog.preview")), false);
    assert.equal(manifest.capabilities.some((capability) => capability.id.includes("catalog.build")), false);
  }, {
    sourceAdapter: { async load(id) { sourceCalls++; return sourceFixtures.load(id); } },
    enrichmentAdapter: { async enrich(record) { enrichmentCalls++; return enrichmentFixtures.enrich(record); } },
    registryAdapter: { async check(record) { registryCalls++; return registryFixtures.check(record); } }
  });
});

test("preview escapes hostile company names and omits unsafe links", async () => {
  const source = { sourceRevision: "fixture-hostile-text-r1", records: [{
    sourceRecordId: "src-hostile-text", name: "<script>alert('preview')</script> & Co", country: "RU", booth: "H-1", href: "https://safe.example.invalid/profile"
  }] };
  const sources = { "demo-expo-001": source };
  await withServer(async (base) => {
    const build = await (await postBuild(base, "demo-profile-a", "preview-hostile-build-01")).json();
    const preview = await (await fetch(`${base}/api/v1/catalog-builds/${build.buildId}/preview`, { method: "POST", headers: headers("demo-profile-a") })).json();
    const html = await (await fetch(`${base}${preview.url}`, { headers: headers("demo-profile-a") })).text();
    assert.ok(html.includes("&lt;script&gt;alert(&#39;preview&#39;)&lt;/script&gt; &amp; Co"));
    assert.equal(html.includes("<script>alert('preview')</script>"), false);
    assert.ok(html.includes('href="https://safe.example.invalid/profile"'));

    const forged = structuredClone(build.artifact);
    forged.companies[0].name = "</h3><img src=x onerror=alert(1)>";
    forged.companies[0].source.href = "javascript:alert(2)";
    forged.companies[0].enrichment.website = 'https://unsafe.example.invalid/" onmouseover="alert(3)';
    const rendered = renderCatalogPreview({ buildId: build.buildId, artifact: forged, buildReport: build.report });
    assert.equal(rendered.valid, true);
    assert.ok(rendered.html.includes("&lt;/h3&gt;&lt;img src=x onerror=alert(1)&gt;"));
    assert.equal(rendered.html.includes('href="javascript:alert(2)"'), false);
    assert.equal(rendered.html.includes('onmouseover="alert(3)"'), false);
  }, { sources, sourceAdapter: { async load() { return source; } }, enrichmentAdapter: { async enrich() { return { status: "not_found", provenance: { provider: "synthetic", fixtureRef: "no-data" } }; } } });
});

test("preview routes are profile scoped and fail closed without trusted identity", async () => {
  const catalogBuilds = createCatalogBuildService();
  const built = await catalogBuilds.build({ profileId: "demo-profile-a", idempotencyKey: "preview-deny-build-01", exhibitionId: "demo-expo-001" });
  const buildId = built.body.buildId;
  const preview = catalogBuilds.preview({ profileId: "demo-profile-a", buildId });
  assert.equal(preview.status, 201);
  await withServer(async (base) => {
    const foreignCreate = await fetch(`${base}/api/v1/catalog-builds/${buildId}/preview`, { method: "POST", headers: headers("demo-profile-b") });
    assert.equal(foreignCreate.status, 404);
    const foreignRead = await fetch(`${base}${preview.body.url}`, { headers: headers("demo-profile-b") });
    assert.equal(foreignRead.status, 404);
  }, { catalogBuilds });
  await withServer(async (base) => {
    const denied = await fetch(`${base}/api/v1/catalog-builds/${buildId}/preview`, { method: "POST" });
    assert.equal(denied.status, 503);
  }, { catalogBuilds, trusted: false });
});
