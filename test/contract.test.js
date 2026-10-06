import test from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFile } from "node:fs/promises";
import { createServer } from "../src/server.js";
import { catalog } from "../src/fixtures.js";

async function withServer(run, options = {}) {
  const server = createServer(options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

test("manifest declares stable v1 read-only contract and capabilities", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/v1/manifest`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.serviceId, "crm-web.exhibitions");
    assert.equal(body.domainApiVersion, "1.0.0");
    assert.deepEqual(body.release, { version: "0.1.0", sourceRevision: "working-tree", environment: "development" });
    assert.deepEqual(body.capabilities, [
      {
        id: "exhibitions.catalog.read", version: "1.0.0", required: true,
        inputSchemaRef: "schemas/catalog-query.schema.json", outputSchemaRef: "schemas/catalog.schema.json",
        effect: "read", requiredScopes: [], operationRef: "GET /api/v1/catalog"
      },
      {
        id: "crm.companies.read", version: "1.0.0", required: true,
        inputSchemaRef: "schemas/company-query.schema.json", outputSchemaRef: "schemas/company-list.schema.json",
        effect: "read", requiredScopes: ["crm.companies.read"], operationRef: "GET /api/v1/companies"
      },
      {
        id: "crm.exhibitions.participants.read", version: "1.0.0", required: true,
        inputSchemaRef: "schemas/s01-participants-input.schema.json", outputSchemaRef: "schemas/s01-participants-output.schema.json",
        errorsSchemaRef: "schemas/s01-participants-errors.schema.json", descriptorRef: "capabilities/s01-exhibition-participants.v1.json",
        handlerBinding: "src/s01-participants.js#readExhibitionParticipants", mcpTool: { name: "crm_exhibitions_participants_read", protocolVersion: "2025-06-18" },
        effect: "read", requiredScopes: ["crm.companies.read"], operationRef: "GET /api/v1/companies"
      },
      {
        id: "crm.exhibitions.catalog.search", version: "1.0.0", required: true,
        inputSchemaRef: "schemas/s01-catalog-search-input.schema.json", outputSchemaRef: "schemas/s01-catalog-search-output.schema.json",
        errorsSchemaRef: "schemas/s01-catalog-search-errors.schema.json", descriptorRef: "capabilities/s01-exhibition-catalog-search.v1.json",
        handlerBinding: "src/catalog-query-v11.js#createCatalogV11SearchHandler", mcpTool: { name: "crm_exhibitions_catalog_search", protocolVersion: "2025-06-18" },
        effect: "read", requiredScopes: ["crm.catalog.read"], operationRef: "GET /api/v1/catalogs/{exhibitionId}/entries"
      },
      {
        id: "crm.company.read", version: "1.0.0", required: false,
        inputSchemaRef: "schemas/company-query.schema.json", outputSchemaRef: "schemas/company.schema.json",
        effect: "read", requiredScopes: ["crm.companies.read"], operationRef: "GET /api/v1/companies/{id}"
      }
    ]);
    const s01 = body.capabilities.find((capability) => capability.id === "crm.exhibitions.participants.read");
    assert.ok(s01);
    assert.equal(s01.descriptorRef, "capabilities/s01-exhibition-participants.v1.json");
    assert.equal(s01.handlerBinding, "src/s01-participants.js#readExhibitionParticipants");
    assert.deepEqual(s01.requiredScopes, ["crm.companies.read"]);
    const catalogSearch = body.capabilities.find((capability) => capability.id === "crm.exhibitions.catalog.search");
    assert.ok(catalogSearch);
    assert.equal(catalogSearch.handlerBinding, "src/catalog-query-v11.js#createCatalogV11SearchHandler");
    assert.equal(catalogSearch.operationRef, "GET /api/v1/catalogs/{exhibitionId}/entries");
    assert.deepEqual(catalogSearch.requiredScopes, ["crm.catalog.read"]);
    assert.equal(body.capabilities.some((capability) => capability.id.startsWith("crm.deal_intents.")), false);
    assert.equal(body.capabilities.some((capability) => capability.id.startsWith("crm.deals.")), false);
    assert.deepEqual(body.readiness, {
      status: "ready", scope: "local_process_only", reason: { code: "local_process_available" },
      checked: {
        serviceId: body.serviceId, release: body.release,
        platformContractRange: body.platformContractRange, domainApiVersion: body.domainApiVersion
      }
    });
    const schema = JSON.parse(await readFile(new URL("../schemas/manifest.schema.json", import.meta.url)));
    assert.ok(new Ajv().compile(schema)(body));
    const schemaAjv = new Ajv();
    addFormats(schemaAjv);
    const referencedSchemas = new Map();
    for (const capability of body.capabilities) {
      for (const reference of [capability.inputSchemaRef, capability.outputSchemaRef, ...(capability.errorsSchemaRef ? [capability.errorsSchemaRef] : [])]) {
        const referencedSchema = JSON.parse(await readFile(new URL(`../${reference}`, import.meta.url)));
        referencedSchemas.set(referencedSchema.$id, referencedSchema);
      }
    }
    for (const referencedSchema of referencedSchemas.values()) schemaAjv.addSchema(referencedSchema);
    for (const referencedSchema of referencedSchemas.values()) assert.ok(schemaAjv.getSchema(referencedSchema.$id));
  }, { catalogV11Repository: { async getArtifact() { return null; } },
    resolveCatalogV11TrustedProfile: async () => ({ profileId: "synthetic-profile", scopes: ["crm.catalog.read"] }) });
});

test("manifest omits profile catalog search when its repository and route are not mounted", async () => {
  await withServer(async (base) => {
    const body = await fetch(`${base}/api/v1/manifest`).then((response) => response.json());
    assert.equal(body.capabilities.some((capability) => capability.id === "crm.exhibitions.catalog.search"), false);
    assert.equal(Object.hasOwn(body.endpoints, "catalogSearch"), false);
  });
});

test("readiness and catalog return the documented shape with synthetic records", async () => {
  await withServer(async (base) => {
    const readiness = await fetch(`${base}/api/v1/readiness`).then((r) => r.json());
    assert.deepEqual(readiness, {
      status: "ready", scope: "local_process_only", reason: { code: "local_process_available" },
      checked: {
        serviceId: "crm-web.exhibitions",
        release: { version: "0.1.0", sourceRevision: "working-tree", environment: "development" },
        platformContractRange: ">=1.0.0 <2.0.0", domainApiVersion: "1.0.0"
      }
    });
    const readinessSchema = JSON.parse(await readFile(new URL("../schemas/readiness.schema.json", import.meta.url)));
    assert.ok(new Ajv().compile(readinessSchema)(readiness));
    for (const state of ["ready", "degraded", "blocked", "unavailable"]) {
      assert.ok(new Ajv().compile(readinessSchema)({ ...readiness, status: state }));
    }
    const result = await fetch(`${base}/api/v1/catalog`).then((r) => r.json());
    assert.equal(result.domainApiVersion, "1.0.0");
    assert.deepEqual(result.items, catalog);
    assert.ok(result.items.every((item) => item.id.startsWith("demo-expo-")));
    const schema = JSON.parse(await readFile(new URL("../schemas/catalog.schema.json", import.meta.url)));
    const ajv = new Ajv();
    addFormats(ajv);
    assert.ok(ajv.compile(schema)(result));
    const filtered = await fetch(`${base}/api/v1/catalog?q=sample`).then((r) => r.json());
    assert.deepEqual(filtered.items.map((item) => item.id), ["demo-expo-001"]);
    for (const query of ["?q=" + "x".repeat(121), "?unknown=value", "?q=sample&q=city"]) {
      const invalid = await fetch(`${base}/api/v1/catalog${query}`);
      assert.equal(invalid.status, 400);
      assert.deepEqual(await invalid.json(), { error: "invalid_query" });
    }
  });
});

test("service serves the page and rejects writes", async () => {
  await withServer(async (base) => {
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Exhibition catalog/);
    const write = await fetch(`${base}/api/v1/catalog`, { method: "POST" });
    assert.equal(write.status, 405);
    assert.equal(write.headers.get("allow"), "GET, HEAD, POST");
  });
});

test("unknown route is a JSON 404", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/missing`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "not_found" });
  });
});
