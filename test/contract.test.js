import test from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFile } from "node:fs/promises";
import { createServer } from "../src/server.js";
import { catalog } from "../src/fixtures.js";

async function withServer(run) {
  const server = createServer();
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
    assert.deepEqual(body, {
      contractVersion: "1.0.0", service: "crm-web", mode: "synthetic-read-only",
      capabilities: ["exhibitions.catalog.read"],
      endpoints: { readiness: { method: "GET", path: "/api/v1/readiness" }, catalog: { method: "GET", path: "/api/v1/catalog" } }
    });
    const schema = JSON.parse(await readFile(new URL("../schemas/manifest.schema.json", import.meta.url)));
    assert.ok(new Ajv().compile(schema)(body));
  });
});

test("readiness and catalog return the documented shape with synthetic records", async () => {
  await withServer(async (base) => {
    const readiness = await fetch(`${base}/api/v1/readiness`).then((r) => r.json());
    assert.deepEqual(readiness, { status: "ready", contractVersion: "1.0.0" });
    const result = await fetch(`${base}/api/v1/catalog`).then((r) => r.json());
    assert.equal(result.contractVersion, "1.0.0");
    assert.deepEqual(result.items, catalog);
    assert.ok(result.items.every((item) => item.id.startsWith("demo-expo-")));
    const schema = JSON.parse(await readFile(new URL("../schemas/catalog.schema.json", import.meta.url)));
    const ajv = new Ajv();
    addFormats(ajv);
    assert.ok(ajv.compile(schema)(result));
    const filtered = await fetch(`${base}/api/v1/catalog?q=sample`).then((r) => r.json());
    assert.deepEqual(filtered.items.map((item) => item.id), ["demo-expo-001"]);
  });
});

test("service serves the page and rejects writes", async () => {
  await withServer(async (base) => {
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Exhibition catalog/);
    const write = await fetch(`${base}/api/v1/catalog`, { method: "POST" });
    assert.equal(write.status, 405);
    assert.equal(write.headers.get("allow"), "GET, HEAD");
  });
});

test("unknown route is a JSON 404", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/missing`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "not_found" });
  });
});
