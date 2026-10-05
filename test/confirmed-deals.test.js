import test from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv/dist/2020.js";
import { readFile } from "node:fs/promises";
import { createServer } from "../src/server.js";
import { createConfirmedDealService } from "../src/confirmed-deals.js";

const scopes = ["crm.deals.confirm.synthetic", "crm.deals.operations.read.synthetic", "crm.deals.links.repair.synthetic"];
const profileHeaders = (profileId, granted = scopes) => ({ "x-test-profile": profileId, "x-test-scopes": granted.join(" ") });
const opId = (n) => `op-00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const request = (n, extras = {}) => ({ companyId: "demo-company-001", exhibitionId: "demo-expo-001", title: "Synthetic sample deal", summary: "Synthetic summary for contract behavior.", confirmation: true, operationId: opId(n), ...extras });

async function withServer(run, { provider, resolver } = {}) {
  const server = createServer({
    ...(provider ? { confirmedDeals: createConfirmedDealService({ provider }) } : {}),
    resolveTrustedProfile: resolver ?? ((req) => ({ profileId: req.headers["x-test-profile"], scopes: (req.headers["x-test-scopes"] ?? "").split(" ").filter(Boolean) }))
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise((resolve, reject) => server.close((e) => e ? reject(e) : resolve())); }
}

async function post(base, profile, body, key = "synthetic-key-0001") {
  return fetch(`${base}/api/v1/deals/confirm`, { method: "POST", headers: { ...profileHeaders(profile), "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body) });
}

test("confirmation and complete fields are required before provider write", async () => {
  let creates = 0;
  const provider = { async create() { creates++; return { status: "created", dealId: `demo-deal-${opId(1).slice(3)}` }; }, async reconcile() { return { status: "unknown" }; }, async repairLink() { return true; } };
  await withServer(async (base) => {
    const noConfirmation = await post(base, "demo-profile-a", request(1, { confirmation: false }));
    assert.equal(noConfirmation.status, 400);
    const incomplete = await post(base, "demo-profile-a", { ...request(2), title: " " });
    assert.equal(incomplete.status, 400);
    assert.equal(creates, 0);
  }, { provider });
});

test("confirmed success replays idempotently with one provider deal", async () => {
  let creates = 0;
  const provider = { async create({ operationId }) { creates++; return { status: "created", dealId: `demo-deal-${operationId.slice(3)}` }; }, async reconcile() { return { status: "unknown" }; }, async repairLink() { return true; } };
  await withServer(async (base) => {
    const first = await post(base, "demo-profile-a", request(3));
    assert.equal(first.status, 201);
    const firstBody = await first.json();
    const repeated = await post(base, "demo-profile-a", request(3));
    assert.equal(repeated.status, 200);
    const replay = await repeated.json();
    assert.equal(replay.replayed, true);
    assert.equal(replay.dealId, firstBody.dealId);
    assert.equal(creates, 1);
  }, { provider });
});

test("unknown provider outcome reconciles before any retry and link repair never creates", async () => {
  let creates = 0, reconciles = 0, repairs = 0, state = "unknown";
  const dealId = `demo-deal-${opId(4).slice(3)}`;
  const provider = {
    async create() { creates++; throw new Error("synthetic timeout after dispatch"); },
    async reconcile() { reconciles++; return state === "created" ? { status: "created", dealId } : { status: "unknown" }; },
    async repairLink(_id, id) { repairs++; return id === dealId; }
  };
  await withServer(async (base) => {
    const first = await post(base, "demo-profile-a", request(4));
    assert.equal(first.status, 202);
    assert.equal((await first.json()).status, "unknown");
    state = "created";
    const replay = await post(base, "demo-profile-a", request(4));
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).status, "created");
    const repair = await fetch(`${base}/api/v1/deal-operations/${opId(4)}/repair`, { method: "POST", headers: profileHeaders("demo-profile-a") });
    assert.equal(repair.status, 200);
    assert.equal((await repair.json()).linkStatus, "linked");
    assert.equal(creates, 1);
    assert.equal(reconciles, 1);
    assert.equal(repairs, 1);
  }, { provider });
});

test("malformed provider create or reconcile success remains unknown without a deal reference", async () => {
  let creates = 0, reconcileResult = { status: "created", dealId: "not-a-synthetic-deal-id" };
  const provider = {
    async create() { creates++; return { status: "created", dealId: "bad-reference" }; },
    async reconcile() { return reconcileResult; },
    async repairLink() { throw new Error("must not run without a valid deal ID"); }
  };
  await withServer(async (base) => {
    const created = await post(base, "demo-profile-a", request(8));
    assert.equal(created.status, 202);
    assert.equal((await created.json()).status, "unknown");
    const reconciled = await fetch(`${base}/api/v1/deal-operations/${opId(8)}/reconcile`, { method: "POST", headers: profileHeaders("demo-profile-a") });
    assert.equal(reconciled.status, 200);
    const body = await reconciled.json();
    assert.equal(body.status, "unknown");
    assert.equal("dealId" in body, false);
    const invalidSchema = (await schemaValidatorForOperation())({ domainApiVersion: "1.0.0", operationId: opId(8), status: "created", companyId: "demo-company-001", exhibitionId: "demo-expo-001", replayed: false });
    assert.equal(invalidSchema, false);
    assert.equal(creates, 1);
  }, { provider });
});

test("reconcile and link provider exceptions return typed unavailable errors and preserve state", async () => {
  let linkThrows = true;
  const dealId = `demo-deal-${opId(9).slice(3)}`;
  const provider = {
    async create() { return { status: "created", dealId }; },
    async reconcile() { throw new Error("private provider detail"); },
    async repairLink() { if (linkThrows) throw new Error("private provider detail"); return true; }
  };
  await withServer(async (base) => {
    const created = await post(base, "demo-profile-a", request(9));
    assert.equal(created.status, 201);
    const reconcile = await fetch(`${base}/api/v1/deal-operations/${opId(9)}/reconcile`, { method: "POST", headers: profileHeaders("demo-profile-a") });
    assert.equal(reconcile.status, 503);
    const reconcileBody = await reconcile.json();
    assert.deepEqual(reconcileBody, { error: "provider_unavailable", operationId: opId(9), status: "created" });
    assert.equal((await schemaValidator("synthetic-deal-operation-error"))(reconcileBody), true);

    const repairFailed = await fetch(`${base}/api/v1/deal-operations/${opId(9)}/repair`, { method: "POST", headers: profileHeaders("demo-profile-a") });
    assert.equal(repairFailed.status, 503);
    assert.deepEqual(await repairFailed.json(), { error: "provider_unavailable", operationId: opId(9), status: "created" });
    linkThrows = false;
    const repairRetried = await fetch(`${base}/api/v1/deal-operations/${opId(9)}/repair`, { method: "POST", headers: profileHeaders("demo-profile-a") });
    assert.equal(repairRetried.status, 200);
    assert.equal((await repairRetried.json()).status, "created");
  }, { provider });
});

test("operation state is isolated by trusted profile and scope", async () => {
  await withServer(async (base) => {
    const created = await post(base, "demo-profile-a", request(5));
    assert.equal(created.status, 201);
    const otherProfile = await fetch(`${base}/api/v1/deal-operations/${opId(5)}/reconcile`, { method: "POST", headers: profileHeaders("demo-profile-b") });
    assert.equal(otherProfile.status, 404);
    const noScope = await fetch(`${base}/api/v1/deals/confirm`, { method: "POST", headers: { ...profileHeaders("demo-profile-a", []), "content-type": "application/json", "idempotency-key": "synthetic-key-0002" }, body: JSON.stringify(request(6)) });
    assert.equal(noScope.status, 403);
  });
});

test("request and operation schemas describe the versioned wire contract", async () => {
  const ajv = new Ajv();
  for (const name of ["synthetic-confirmed-deal-request", "synthetic-deal-operation", "synthetic-deal-operation-error"]) {
    const schema = JSON.parse(await readFile(new URL(`../schemas/${name}.schema.json`, import.meta.url)));
    ajv.addSchema(schema);
  }
  assert.equal(ajv.getSchema("https://crm-web.example.invalid/schemas/synthetic-confirmed-deal-request.schema.json")(request(7)), true);
  assert.equal(ajv.getSchema("https://crm-web.example.invalid/schemas/synthetic-deal-operation.schema.json")({ domainApiVersion: "1.0.0", operationId: opId(7), status: "created", companyId: "demo-company-001", exhibitionId: "demo-expo-001", dealId: `demo-deal-${opId(7).slice(3)}`, replayed: false }), true);
});

async function schemaValidator(name) {
  const ajv = new Ajv();
  const schema = JSON.parse(await readFile(new URL(`../schemas/${name}.schema.json`, import.meta.url)));
  ajv.addSchema(schema);
  return ajv.getSchema(`https://crm-web.example.invalid/schemas/${name}.schema.json`);
}

async function schemaValidatorForOperation() {
  return schemaValidator("synthetic-deal-operation");
}
