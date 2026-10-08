import test from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "../src/server.js";
import { createCatalogBuildService, createSyntheticSourceAdapter, createSyntheticEnrichmentAdapter, createSyntheticRegistryAdapter, normalizeEnrichment, normalizeRegistry, qualify } from "../src/catalog-build.js";
import { renderCatalogPreview } from "../src/catalog-preview.js";
import { importLegacyExSnapshotV11, projectLegacyExSnapshotV11, projectLegacyExSnapshotV12 } from "../src/legacy-ex-snapshot.js";
import { queryCatalogV11, renderCatalogV11, createCatalogV11ReadHandler,
  createCatalogV11SearchHandler, createCatalogV11D1Repository } from "../src/catalog-query-v11.js";
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
  const ajv = new Ajv({ strict: false });
  addFormats(ajv);
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
    assert.equal(responseSchema(body), true, JSON.stringify(responseSchema.errors));
    assert.equal(body.report.validation.valid, true);
    assert.deepEqual(body.report.validation.counts, {
      sourceRecords: 5, uniqueCompanies: 4, duplicateRecords: 1,
      enrichmentFound: 3, enrichmentNotFound: 0, enrichmentUnavailable: 1,
      registryOk: 1, registryUnknown: 1, registrySanctioned: 1, registryNotFound: 0, registryInactive: 1,
      targets: 1, nearTargets: 2, notTargets: 1, unknowns: 0
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
    source: { sourceRecordId: "src-synthetic-boundary", country: "Fictionland", booth: "A-14",
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
  assert.match(view.html, /<option value="RU"/);
  assert.match(view.html, /Стенд: A-14/);
  assert.match(view.html, /Найдено: 1/);
  assert.equal(view.html.includes("Карточка CRM и подготовка сделки"), false,
    "do not show an S-04 path without a current imported participant binding");
  const linkedView = renderCatalogV11({ artifact: queryArtifact, result: filtered,
    participantCompanyIds: [rows.find(row => row.name === "Revenue Upper Boundary").id] });
  assert.match(linkedView.html, /Карточка CRM и подготовка сделки/);
  assert.match(linkedView.html, /\/catalogs\/synthetic-current-source-shape\/participants\/co-2123456789abcdef0123/);
  const countryView = renderCatalogV11({ artifact: queryArtifact,
    result: queryCatalogV11(queryArtifact, { country: "RU" }), filters: { country: "RU" } });
  assert.match(countryView.html, /<option value="RU" selected>/);
  assert.match(countryView.html, /Найдено: 1/);
  const hostile = structuredClone(queryArtifact);
  hostile.companies = [{ ...structuredClone(company), name: '<img src=x onerror="bad">',
    source: { ...company.source, category: "<script>bad</script>", description: "<b>bad</b>",
      booth: "<script>bad</script>", href: "https://example.invalid/a\\\" onmouseover=bad" } }];
  const safeView = renderCatalogV11({ artifact: hostile, result: queryCatalogV11(hostile), filters: {} });
  assert.equal(safeView.html.includes("<img src=x"), false);
  assert.equal(safeView.html.includes("<script>bad</script>"), false);
  assert.match(safeView.html, /Стенд: &lt;script&gt;bad&lt;\/script&gt;/);
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
  const countryResponse = await fetchHandler("demo-profile-a", "crm.catalog.read",
    "/catalogs/synthetic-current-source-shape?country=RU");
  assert.equal(countryResponse.status, 200);
  const countryHtml = await countryResponse.text();
  assert.match(countryHtml, /<option value="RU" selected>/);
  assert.match(countryHtml, /Стенд: A-14/);
  assert.equal((await fetchHandler("demo-profile-a", "")).status, 403);
  assert.equal((await fetchHandler("demo-profile-b")).status, 404);
  assert.equal((await fetchHandler("unavailable")).status, 503);
  assert.equal((await fetchHandler("demo-profile-a", "crm.catalog.read", "/catalogs/synthetic-current-source-shape?revenueBand=unsafe")).status, 400);
  assert.equal((await fetchHandler("demo-profile-a", "crm.catalog.read", "/catalogs/synthetic-current-source-shape?query=a&query=b")).status, 400);
  assert.ok(calls.every(scope => scope.profileId !== "demo-profile-b" || scope.exhibitionId === "synthetic-current-source-shape"));

  const search = createCatalogV11SearchHandler({ repository: {
    async getArtifact(scope) {
      calls.push(scope);
      return scope.profileId === "demo-profile-a" ? queryArtifact : null;
    }
  }, resolveTrustedProfile: async request => request.headers.get("x-test-profile") === "unavailable"
    ? (() => { throw new Error("identity unavailable"); })()
    : ({ profileId: request.headers.get("x-test-profile"), scopes: request.headers.get("x-test-scope")?.split(" ") ?? [] }) });
  const searchRequest = (profileId, query = "", scope = "crm.catalog.read") => search(new Request(
    `https://crm.example.invalid/api/v1/catalogs/synthetic-current-source-shape/entries${query}`,
    { headers: { "x-test-profile": profileId, "x-test-scope": scope } }));
  const searchResponse = await searchRequest("demo-profile-a", "?query=Unknown%20Finance&limit=1");
  assert.equal(searchResponse.status, 200);
  const searchBody = await searchResponse.json();
  const { "s01-catalog-search-output": validateSearch } = await validators("s01-catalog-search-input", "s01-catalog-search-output", "s01-catalog-search-errors");
  assert.equal(validateSearch(searchBody), true);
  assert.equal(searchBody.total, 1);
  assert.equal(searchBody.items.length, 1);
  assert.deepEqual(Object.keys(searchBody.items[0]).sort(), ["activity", "booth", "category", "classification", "country", "description", "id", "name", "profitRub", "profitYear", "revenueRub", "revenueYear", "segment", "website"].sort());
  assert.equal("inn" in searchBody.items[0], false);
  assert.equal("ogrn" in searchBody.items[0], false);
  assert.equal("sourceRecordId" in searchBody.items[0], false);
  assert.equal((await searchRequest("demo-profile-a", "?profileId=demo-profile-b")).status, 400);
  assert.equal((await searchRequest("demo-profile-a", "?limit=101")).status, 400);
  assert.equal((await searchRequest("demo-profile-a", "?offset=20001")).status, 400);
  assert.equal((await searchRequest("demo-profile-a", "?query=x&query=y")).status, 400);
  assert.equal((await searchRequest("demo-profile-a", "", "")).status, 403);
  assert.equal((await searchRequest("demo-profile-b")).status, 404);
  assert.equal((await searchRequest("unavailable")).status, 503);
});

test("S-01 v1.2 golden carries public business facts with period and provenance, and keeps unknown values null", async () => {
  const row = { id: "SYNTH001", n: "Synthetic Public Company", s: "S-01", t: 1, nt: 0,
    inn: "0000000001", ogrn: null, ru: 1, country: "Sample Federation", cat: "Manufacturing",
    b: "Synthetic source description", seg: "Synthetic segment", rev: 250, ry: 2025,
    prof: 0, py: 2024, href: "https://example.invalid/company", dir: "Synthetic Director",
    dirpos: "Synthetic director role", taxesPaidRub: 1_250_000, taxesPaidYear: 2024,
    taxesPaidProvider: "synthetic-registry", employeeCount: 42, employeeYear: 2025,
    employeeDefinition: "year_end", employeeCountProvider: "synthetic-registry" };
  const projected = projectLegacyExSnapshotV12({ profileRef: "demo-profile-a",
    eventKey: "synthetic-business-facts", entries: [row] });
  assert.equal(projected.status, "projected");
  const company = projected.artifact.companies[0];
  assert.deepEqual(company.source.director, { name: "Synthetic Director", position: "Synthetic director role",
    provenance: { provider: "legacy-ex-snapshot", fixtureRef: projected.artifact.sourceRevision } });
  assert.deepEqual(company.enrichment.taxesPaid, { amountRub: 1_250_000, period: "2024",
    provenance: { provider: "synthetic-registry", fixtureRef: projected.artifact.sourceRevision } });
  assert.deepEqual(company.enrichment.employeeCount, { count: 42, period: "2025", definition: "year_end",
    provenance: { provider: "synthetic-registry", fixtureRef: projected.artifact.sourceRevision } });
  const missing = projectLegacyExSnapshotV12({ profileRef: "demo-profile-a", eventKey: "synthetic-business-facts",
    entries: [{ ...row, dir: undefined, dirpos: undefined, taxesPaidRub: undefined, taxesPaidYear: undefined,
      taxesPaidProvider: undefined, employeeCount: undefined, employeeYear: undefined,
      employeeDefinition: undefined, employeeCountProvider: undefined }] }).artifact.companies[0];
  assert.deepEqual(missing.source.director, { name: null, position: null, provenance: null });
  assert.deepEqual(missing.enrichment.taxesPaid, { amountRub: null, period: null, provenance: null });
  assert.deepEqual(missing.enrichment.employeeCount, { count: null, period: null, definition: null, provenance: null });
  for (const invalid of [{ taxesPaidRub: -1 }, { taxesPaidRub: 1.5 }, { taxesPaidYear: 1800 },
    { employeeCount: -1 }, { employeeCount: 2.5 }, { employeeDefinition: "invented" }]) {
    assert.equal(projectLegacyExSnapshotV12({ profileRef: "demo-profile-a", eventKey: "synthetic-business-facts",
      entries: [{ ...row, ...invalid }] }).status, "legacy_record_invalid");
  }
  const schema = JSON.parse(await readFile(new URL("../schemas/catalog-build-artifact-v1.2.schema.json", import.meta.url)));
  const validate = new Ajv({ strict: false }).compile(schema);
  assert.equal(validate(projected.artifact), true, JSON.stringify(validate.errors));
  const outputSchema = JSON.parse(await readFile(new URL("../schemas/s01-catalog-search-output.schema.json", import.meta.url)));
  const outputAjv = new Ajv({ strict: true });
  addFormats(outputAjv);
  const validateOutput = outputAjv.compile(outputSchema);
  const item = { id: company.id, name: company.name, country: company.source.country, booth: company.source.booth,
    category: company.source.category, description: company.source.description, segment: company.source.segment,
    revenueRub: company.enrichment.revenueRub, revenueYear: company.enrichment.revenueYear,
    profitRub: company.enrichment.profitRub, profitYear: company.enrichment.profitYear,
    activity: company.enrichment.activity, website: company.enrichment.website, classification: "target",
    taxesPaidRub: company.enrichment.taxesPaid.amountRub, taxesPaidPeriod: company.enrichment.taxesPaid.period,
    taxesPaidProvenance: company.enrichment.taxesPaid.provenance,
    employeeCount: company.enrichment.employeeCount.count, employeePeriod: company.enrichment.employeeCount.period,
    employeeDefinition: company.enrichment.employeeCount.definition,
    employeeProvenance: company.enrichment.employeeCount.provenance,
    directorName: company.source.director.name, directorPosition: company.source.director.position,
    directorProvenance: company.source.director.provenance };
  const output = { domainApiVersion: "1.1.0", artifactVersion: "1.2.0", exhibitionId: projected.artifact.exhibitionId,
    sourceRevision: projected.artifact.sourceRevision, total: 1, limit: 25, offset: 0, items: [item] };
  assert.equal(validateOutput(output), true, JSON.stringify(validateOutput.errors));
  const v11Output = { ...output, domainApiVersion: "1.0.0", artifactVersion: "1.1.0",
    items: [{ ...item, taxesPaidRub: undefined, taxesPaidPeriod: undefined, taxesPaidProvenance: undefined,
      employeeCount: undefined, employeePeriod: undefined, employeeDefinition: undefined, employeeProvenance: undefined,
      directorName: undefined, directorPosition: undefined, directorProvenance: undefined }] };
  for (const [label, mutate] of [
    ["known taxes require provenance", value => { value.items[0].taxesPaidProvenance = null; }],
    ["known taxes require a period", value => { value.items[0].taxesPaidPeriod = null; }],
    ["artifact and domain API versions must agree", value => { value.domainApiVersion = "1.0.0"; }],
    ["v1.1 forbids v1.2 fields", value => { value.items[0].directorName = null; }]
  ]) {
    const invalid = structuredClone(label === "v1.1 forbids v1.2 fields" ? v11Output : output);
    mutate(invalid);
    assert.equal(validateOutput(invalid), false, label);
  }
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
  db.run(await readFile(new URL("../migrations/0010_catalog_v11_artifacts.sql", import.meta.url), "utf8"));
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
  const persistedSearch = createCatalogV11SearchHandler({ repository: repo,
    resolveTrustedProfile: async () => ({ profileId: "demo-profile-a", scopes: ["crm.catalog.read"] }) });
  const page = await persistedHandler(new Request(`https://crm.example.invalid/catalogs/${artifact.exhibitionId}`));
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Synthetic durable row/);
  const jsonResult = await persistedSearch(new Request(`https://crm.example.invalid/api/v1/catalogs/${artifact.exhibitionId}/entries?limit=10`));
  assert.equal(jsonResult.status, 200);
  assert.deepEqual((await jsonResult.json()).items.map(item => item.name), ["Synthetic durable row"]);
  const server = createServer({ catalogV11Repository: repo,
    resolveCatalogV11TrustedProfile: async () => ({ profileId: "demo-profile-a", scopes: ["crm.catalog.read"] }) });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const transported = await fetch(`http://127.0.0.1:${address.port}/catalogs/${artifact.exhibitionId}`);
    assert.equal(transported.status, 200);
    assert.match(transported.headers.get("content-type"), /text\/html/);
    assert.match(await transported.text(), /Synthetic durable row/);
    const structured = await fetch(`http://127.0.0.1:${address.port}/api/v1/catalogs/${artifact.exhibitionId}/entries?limit=10`);
    assert.equal(structured.status, 200);
    assert.match(structured.headers.get("content-type"), /application\/json/);
    assert.deepEqual((await structured.json()).items.map(item => item.name), ["Synthetic durable row"]);
  } finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  db.run("UPDATE crm_catalog_v11_artifacts SET artifact_json=? WHERE profile_ref=?",
    [JSON.stringify({ ...revisionTwo, sourceRevision: "forged" }), "demo-profile-a"]);
  await assert.rejects(repo.getArtifact({ profileId: "demo-profile-a", exhibitionId: artifact.exhibitionId }), /integrity check failed/);
  const unavailable = await createCatalogV11ReadHandler({ repository: repo,
    resolveTrustedProfile: async () => ({ profileId: "demo-profile-a", scopes: ["crm.catalog.read"] }) })
    (new Request(`https://crm.example.invalid/catalogs/${artifact.exhibitionId}`));
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error, "catalog_unavailable");
  const malformedJson = JSON.stringify({ ...revisionTwo, companies: [{ id: "co-0123456789abcdef0123", name: "incomplete" }] });
  const malformedSha = createHash("sha256").update(malformedJson).digest("hex");
  db.run("UPDATE crm_catalog_v11_artifacts SET artifact_json=?,content_sha=? WHERE profile_ref=?",
    [malformedJson, malformedSha, "demo-profile-a"]);
  await assert.rejects(repo.getArtifact({ profileId: "demo-profile-a", exhibitionId: artifact.exhibitionId }), /artifact is invalid/);
  db.close();
});

test("legacy v1.1 projection preserves catalog display semantics through durable HTTP read without contacts", async () => {
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
  const baseRows = [
    { id: "SYN001", n: "Synthetic below", s: "A-1", t: 0, nt: 1, inn: null, ogrn: null, ru: 1,
      country: "Sample Federation", cat: "Synthetic textile", b: "<b>Synthetic catalog description</b>", seg: "Synthetic retail",
      rev: 99.999999, ry: 2025, prof: -0.000001, py: 2024, href: "https://example.invalid/synthetic-profile" },
    { id: "SYN002", n: "Synthetic lower edge", s: "B-2", t: 0, nt: 0, inn: null, ogrn: null, ru: 0,
      country: null, cat: "Synthetic footwear", b: "Lower edge description", seg: null,
      rev: 100, ry: null, prof: 0, py: null },
    { id: "SYN003", n: "Synthetic upper edge", s: null, t: 0, nt: 0, inn: null, ogrn: null, ru: 0,
      country: "Sampleland", cat: "Synthetic equipment", b: null, seg: null,
      rev: 1500, ry: 2023, prof: 30, py: 2022 },
    { id: "SYN004", n: "Synthetic above", s: "D-4", t: 0, nt: 0, inn: null, ogrn: null, ru: 0,
      country: "Sampleland", cat: null, b: null, seg: null,
      rev: 1500.000001, ry: 2026, prof: 200, py: 2025 }
  ];
  const rowsWithUnapprovedContacts = [{ ...baseRows[0], phone: "synthetic-contact-do-not-import", email: "synthetic-contact-do-not-import" }, ...baseRows.slice(1)];
  const projected = projectLegacyExSnapshotV11({ profileRef: "demo-profile-a", eventKey: "synthetic-legacy-v11", entries: rowsWithUnapprovedContacts });
  assert.equal(projected.status, "projected");
  assert.equal(projected.artifact.schemaVersion, "1.1.0");
  const below = projected.artifact.companies.find(company => company.name === "Synthetic below");
  const lowerEdge = projected.artifact.companies.find(company => company.name === "Synthetic lower edge");
  assert.equal(below.source.country, "Sample Federation");
  assert.equal(below.source.category, "Synthetic textile");
  assert.equal(below.source.segment, "Synthetic retail");
  assert.equal(below.enrichment.revenueRub, 99_999_999);
  assert.equal(below.enrichment.revenueYear, 2025);
  assert.equal(below.enrichment.profitRub, -1);
  assert.equal(below.enrichment.profitYear, 2024);
  assert.equal(lowerEdge.source.country, "unknown");
  assert.equal(lowerEdge.enrichment.revenueRub, 100_000_000);
  assert.equal(lowerEdge.enrichment.revenueYear, null);
  assert.equal(lowerEdge.enrichment.profitRub, 0);
  assert.equal(lowerEdge.enrichment.profitYear, null);
  assert.equal(JSON.stringify(projected.artifact).includes("synthetic-contact-do-not-import"), false);
  const noContacts = projectLegacyExSnapshotV11({ profileRef: "demo-profile-a", eventKey: "synthetic-legacy-v11", entries: baseRows });
  assert.equal(noContacts.artifact.sourceRevision, projected.artifact.sourceRevision);
  assert.equal(projectLegacyExSnapshotV11({ profileRef: "demo-profile-a", eventKey: "synthetic-legacy-v11",
    entries: [{ ...baseRows[0], rev: Number.MAX_VALUE }] }).status, "legacy_record_invalid");
  assert.equal(projectLegacyExSnapshotV11({ profileRef: "demo-profile-a", eventKey: "synthetic-legacy-v11",
    entries: [{ ...baseRows[0], ry: 1800 }] }).status, "legacy_record_invalid");

  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(await readFile(new URL("../migrations/0010_catalog_v11_artifacts.sql", import.meta.url), "utf8"));
  const repo = createCatalogV11D1Repository(new LocalD1(db), () => "2026-10-06T00:00:00.000Z");
  const input = { repository: repo, profileRef: "demo-profile-a", eventKey: "synthetic-legacy-v11", entries: rowsWithUnapprovedContacts };
  assert.equal((await importLegacyExSnapshotV11(input)).status, "stored");
  assert.equal((await importLegacyExSnapshotV11(input)).status, "replay");
  const server = createServer({ catalogV11Repository: repo,
    resolveCatalogV11TrustedProfile: async () => ({ profileId: "demo-profile-a", scopes: ["crm.catalog.read"] }) });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const origin = `http://127.0.0.1:${address.port}`;
    const search = async query => fetch(`${origin}/api/v1/catalogs/synthetic-legacy-v11/entries${query}`).then(response => response.json());
    assert.deepEqual((await search("?query=synthetic%20textile")).items.map(item => item.name), ["Synthetic below"]);
    assert.deepEqual((await search("?country=Sample%20Federation")).items.map(item => item.name), ["Synthetic below"]);
    assert.deepEqual((await search("?revenueBand=0-100")).items.map(item => item.name), ["Synthetic below"]);
    assert.deepEqual((await search("?revenueBand=100-1500")).items.map(item => item.name).sort(),
      ["Synthetic lower edge", "Synthetic upper edge"]);
    assert.deepEqual((await search("?revenueBand=1500%2B")).items.map(item => item.name), ["Synthetic above"]);
    assert.deepEqual((await search("?profitBand=loss")).items.map(item => item.name), ["Synthetic below"]);
    assert.deepEqual((await search("?profitBand=0-30")).items.map(item => item.name), ["Synthetic lower edge"]);
    assert.deepEqual((await search("?profitBand=30-200")).items.map(item => item.name), ["Synthetic upper edge"]);
    assert.deepEqual((await search("?profitBand=200%2B")).items.map(item => item.name), ["Synthetic above"]);
    const page = await fetch(`${origin}/catalogs/synthetic-legacy-v11?profitBand=loss`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /&lt;b&gt;Synthetic catalog description&lt;\/b&gt;/);
    assert.equal(html.includes("synthetic-contact-do-not-import"), false);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.close();
  }
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
    for (const token of ["data-preview-only=\"true\"", "id=\"searchInput\"", "data-filter=\"target\"", "data-filter=\"near\"", "data-filter=\"not-target\"", "data-filter=\"unknown\"", "data-filter=\"registry-review\"", "id=\"alphaNav\"", "id=\"catalog\"", "class=\"company-card", "class=\"target-badge\"", "class=\"near-badge\"", "class=\"not-target-badge\"", "class=\"enrichment-badge", "class=\"registry-badge", "class=\"card-link profile-link\"", "class=\"card-link website-link\""]) assert.ok(html.includes(token), `missing ${token}`);
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

test("legacy qualification unknown renders explicitly and is not styled as not-target", () => {
  const rendered = renderCatalogPreview({ buildId: `build-${"a".repeat(24)}`, artifact: {
    schemaVersion: "1.1.0", exhibitionId: "synthetic-current-source-shape", sourceRevision: "synthetic-revision",
    companies: [{ id: `co-${"b".repeat(20)}`, name: "Synthetic unknown participant",
      source: { sourceRecordId: `src-${"c".repeat(24)}`, country: "RU", booth: "A-01", href: null,
        duplicateSourceRecordIds: [] },
      enrichment: { status: "found", inn: null, ogrn: null, revenueRub: 250000000,
        activity: "unknown", website: null, provenance: { provider: "synthetic", fixtureRef: "synthetic" } },
      registry: { status: "unknown", provenance: { source: "synthetic", fixtureRef: "synthetic" } },
      qualification: { classification: "unknown", target: false, nearTarget: false,
        reason: "legacy_classification_unverified" } }]
  }, buildReport: { validation: { valid: true } } });
  assert.equal(rendered.valid, true);
  assert.match(rendered.html, /СТАТУС НЕ ПОДТВЕРЖДЁН/);
  assert.doesNotMatch(rendered.html, /НЕ ЦЕЛЕВАЯ/);
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
