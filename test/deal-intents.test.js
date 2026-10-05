import test from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFile } from "node:fs/promises";
import { createServer } from "../src/server.js";
import { createDealIntentService, FakeWeeekAdapter } from "../src/deal-intents.js";

class RecordingFakeAdapter extends FakeWeeekAdapter {
  preparations = 0;
  reconciliations = 0;

  async prepare(args) {
    this.preparations += 1;
    return super.prepare(args);
  }

  async reconcile(reference) {
    this.reconciliations += 1;
    return super.reconcile(reference);
  }
}

async function withServer(run, { profile = undefined, adapter = new RecordingFakeAdapter() } = {}) {
  const server = createServer({
    ...(profile ? { resolveTrustedProfile: (request) => request.headers["x-test-profile"] } : {}),
    dealIntents: createDealIntentService({ adapter })
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try { await run(`http://127.0.0.1:${address.port}`, adapter); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

const requestBody = {
  companyId: "demo-company-001",
  exhibitionId: "demo-expo-001",
  summary: "Discuss a synthetic exhibition follow-up"
};

function profileHeaders(profileId) {
  return { "x-test-profile": profileId };
}

test("company to deal-intent flow is profile-scoped and reconciles through fake adapter", async () => {
  await withServer(async (base, adapter) => {
    const companyList = await fetch(`${base}/api/v1/companies`, { headers: profileHeaders("demo-profile-a") });
    assert.equal(companyList.status, 200);
    const visibleCompanies = await companyList.json();
    assert.deepEqual(visibleCompanies.items.map((item) => item.id), ["demo-company-001"]);
    const listSchema = JSON.parse(await readFile(new URL("../schemas/company-list.schema.json", import.meta.url)));
    assert.ok(new Ajv().compile(listSchema)(visibleCompanies));
    const companyDetail = await fetch(`${base}/api/v1/companies/demo-company-001`, { headers: profileHeaders("demo-profile-a") });
    assert.equal(companyDetail.status, 200);
    const detail = await companyDetail.json();
    const detailSchema = JSON.parse(await readFile(new URL("../schemas/company.schema.json", import.meta.url)));
    assert.ok(new Ajv().compile(detailSchema)(detail));
    const invalidCompanyQuery = await fetch(`${base}/api/v1/companies?profileId=demo-profile-a`, { headers: profileHeaders("demo-profile-a") });
    assert.equal(invalidCompanyQuery.status, 400);
    assert.deepEqual(await invalidCompanyQuery.json(), { error: "invalid_query" });

    const create = () => fetch(`${base}/api/v1/deal-intents`, {
      method: "POST",
      headers: { ...profileHeaders("demo-profile-a"), "content-type": "application/json", "idempotency-key": "operation-0001" },
      body: JSON.stringify(requestBody)
    });
    const responses = await Promise.all([create(), create()]);
    responses.sort((left, right) => right.status - left.status);
    const [created, concurrentReplay] = responses;
    assert.equal(created.status, 201);
    const intent = await created.json();
    assert.equal(intent.status, "prepared");
    assert.equal(intent.adapter.status, "accepted");
    assert.equal(intent.replayed, false);
    assert.equal("profileId" in intent, false);
    assert.equal(adapter.preparations, 1);

    const requestSchema = JSON.parse(await readFile(new URL("../schemas/deal-intent-request.schema.json", import.meta.url)));
    const responseSchema = JSON.parse(await readFile(new URL("../schemas/deal-intent-response.schema.json", import.meta.url)));
    const ajv = new Ajv();
    addFormats(ajv);
    assert.ok(ajv.compile(requestSchema)(requestBody));
    assert.ok(ajv.compile(responseSchema)(intent));

    assert.equal(concurrentReplay.status, 200);
    const replayed = await concurrentReplay.json();
    assert.equal(replayed.id, intent.id);
    assert.equal(replayed.replayed, true);
    assert.equal(adapter.preparations, 1);
    const reordered = await fetch(`${base}/api/v1/deal-intents`, {
      method: "POST",
      headers: { ...profileHeaders("demo-profile-a"), "content-type": "application/json", "idempotency-key": "operation-0001" },
      body: JSON.stringify({ summary: requestBody.summary, exhibitionId: requestBody.exhibitionId, companyId: requestBody.companyId })
    });
    assert.equal(reordered.status, 200);
    assert.equal((await reordered.json()).id, intent.id);
    assert.equal(adapter.preparations, 1);

    const status = await fetch(`${base}/api/v1/deal-intents/${intent.id}`, { headers: profileHeaders("demo-profile-a") });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).adapter.status, "accepted");
    assert.equal(adapter.reconciliations, 1);
    const invalidStatusQuery = await fetch(`${base}/api/v1/deal-intents/${intent.id}?id=other`, { headers: profileHeaders("demo-profile-a") });
    assert.equal(invalidStatusQuery.status, 400);
  }, { profile: true });
});

test("idempotency conflict and cross-profile company/intent access are rejected", async () => {
  await withServer(async (base, adapter) => {
    const create = (profileId, key, payload) => fetch(`${base}/api/v1/deal-intents`, {
      method: "POST",
      headers: { ...profileHeaders(profileId), "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify(payload)
    });
    const ownerResponse = await create("demo-profile-a", "operation-shared", requestBody);
    const ownerIntent = await ownerResponse.json();

    const hiddenCompany = await fetch(`${base}/api/v1/companies/demo-company-001`, { headers: profileHeaders("demo-profile-b") });
    assert.equal(hiddenCompany.status, 404);
    const hiddenIntent = await fetch(`${base}/api/v1/deal-intents/${ownerIntent.id}`, { headers: profileHeaders("demo-profile-b") });
    assert.equal(hiddenIntent.status, 404);

    const invalidCompany = await create("demo-profile-a", "operation-other", {
      ...requestBody, companyId: "demo-company-002", exhibitionId: "demo-expo-002"
    });
    assert.equal(invalidCompany.status, 404);
    assert.deepEqual(await invalidCompany.json(), { error: "company_or_exhibition_not_found" });

    const conflict = await create("demo-profile-a", "operation-shared", { ...requestBody, summary: "Different content" });
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { error: "idempotency_conflict" });

    const sameKeyOtherProfile = await create("demo-profile-b", "operation-shared", {
      companyId: "demo-company-002", exhibitionId: "demo-expo-002", summary: "Profile B synthetic intent"
    });
    assert.equal(sameKeyOtherProfile.status, 201);
    assert.notEqual((await sameKeyOtherProfile.json()).id, ownerIntent.id);
    assert.equal(adapter.preparations, 2);

    const prototypeNamedProfile = await fetch(`${base}/api/v1/companies`, { headers: profileHeaders("toString") });
    assert.equal(prototypeNamedProfile.status, 200);
    assert.deepEqual((await prototypeNamedProfile.json()).items, []);
  }, { profile: true });
});

test("writes fail closed without a trusted profile resolver and profileId is not request data", async () => {
  await withServer(async (base) => {
    const noResolver = await fetch(`${base}/api/v1/deal-intents`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "operation-0002" },
      body: JSON.stringify(requestBody)
    });
    assert.equal(noResolver.status, 503);
    assert.deepEqual(await noResolver.json(), { error: "trusted_profile_unavailable" });
  });

  await withServer(async (base) => {
    const injectedProfile = await fetch(`${base}/api/v1/deal-intents`, {
      method: "POST",
      headers: { ...profileHeaders("demo-profile-a"), "content-type": "application/json", "idempotency-key": "operation-0003" },
      body: JSON.stringify({ ...requestBody, profileId: "demo-profile-b" })
    });
    assert.equal(injectedProfile.status, 400);
    assert.deepEqual(await injectedProfile.json(), { error: "invalid_request" });
  }, { profile: true });
});
