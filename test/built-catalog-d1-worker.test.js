import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

const wrangler = new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url).pathname;
const node = process.env.CRM_S04_WRANGLER_NODE || process.execPath;
const cwd = new URL("..", import.meta.url).pathname;
const config = "test/wrangler.built-catalog-local.toml";

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function startWorker(root) {
  const port = await freePort();
  const child = spawn(node, [wrangler, "dev", "--config", config, "--ip", "127.0.0.1",
    "--port", String(port), "--persist-to", root, "--log-level", "error"],
    { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout.on("data", (part) => { logs += part; });
  child.stderr.on("data", (part) => { logs += part; });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`local Worker exited: ${logs}`);
    try { if ((await fetch(`${base}/health`)).ok) return { child, base }; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  child.kill("SIGTERM");
  throw new Error(`local Worker did not start: ${logs}`);
}
async function stopWorker(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => child.once("close", resolve)),
    new Promise((resolve) => setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 3000))]);
}
async function call(base, path, body, { profile = "demo-profile-a", approval = false } = {}) {
  const response = await fetch(`${base}${path}`, { method: "POST", headers: {
    "content-type": "application/json", "x-test-profile": profile,
    ...(approval ? { "x-test-approval": "approved" } : {}) }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

test("D1 built catalog, stable prelead/note and reviewed deal survive three Worker instances", async () => {
  const root = mkdtempSync(join(tmpdir(), "crm-built-catalog-d1-"));
  let worker;
  try {
    for (const migration of ["migrations/0001_s04_domain.sql", "migrations/0002_built_catalog.sql"]) {
      const applied = spawnSync(node, [wrangler, "d1", "execute", "CRM_DB", "--config", config,
        "--local", "--persist-to", root, "--file", migration, "--yes", "--json"], { cwd, encoding: "utf8" });
      assert.equal(applied.status, 0, applied.stderr || applied.stdout);
    }
    worker = await startWorker(root);
    const built = await call(worker.base, "/catalog/build", { exhibitionId: "demo-expo-001", idempotencyKey: "durable-build-a" });
    assert.equal(built.status, 201, JSON.stringify(built.body));
    const buildId = built.body.buildId;
    const list = await call(worker.base, "/catalog/read", { buildId, classification: "target" });
    assert.equal(list.status, 200);
    const companyId = list.body.items[0].id;
    const binding = await call(worker.base, "/catalog/bind", { buildId, companyId });
    assert.equal(binding.status, 201, JSON.stringify(binding.body));
    const preleadId = binding.body.prelead.id;
    const operationId = `op-${randomUUID()}`;
    const note = await call(worker.base, "/prelead/note", { preleadId, operationId, noteText: "Durable synthetic interest" });
    assert.equal(note.status, 201, JSON.stringify(note.body));
    assert.equal((await call(worker.base, "/prelead/note", { preleadId, operationId,
      noteText: "Durable synthetic interest" })).status, 200);
    assert.equal((await call(worker.base, "/prelead/note", { preleadId, operationId,
      noteText: "Changed text" })).status, 409);
    assert.equal((await call(worker.base, "/prelead/note", { preleadId,
      operationId: `op-${randomUUID()}`, noteText: "Cross profile" }, { profile: "demo-profile-b" })).status, 404);
    await stopWorker(worker.child);

    worker = await startWorker(root);
    const recovered = await call(worker.base, "/catalog/read", { buildId, companyId });
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body.items[0].name, "Example Machine Works");
    const other = await call(worker.base, "/catalog/read", { buildId, companyId }, { profile: "demo-profile-b" });
    assert.equal(other.status, 404);
    const replayBuild = await call(worker.base, "/catalog/build", { exhibitionId: "demo-expo-001", idempotencyKey: "durable-build-a" });
    assert.equal(replayBuild.status, 200);
    assert.equal(replayBuild.body.buildId, buildId);
    const rebuilt = await call(worker.base, "/catalog/build", { exhibitionId: "demo-expo-001", idempotencyKey: "durable-build-b" });
    assert.equal(rebuilt.status, 201);
    const rebound = await call(worker.base, "/catalog/bind", { buildId: rebuilt.body.buildId, companyId });
    assert.equal(rebound.body.prelead.id, preleadId);
    const context = await call(worker.base, "/prelead/context", { exhibitionId: "demo-expo-001", companyId });
    assert.deepEqual(context.body.notes, ["Durable synthetic interest"]);
    const draft = { buildId: rebuilt.body.buildId, companyId, exhibitionId: "demo-expo-001",
      title: "Durable synthetic deal", companyInn: "0000000001", contactName: "Example Contact",
      dealComment: "Discuss sample offer" };
    const review = await call(worker.base, "/review/prepare", draft);
    assert.equal(review.status, 201, JSON.stringify(review.body));
    assert.match(review.body.details.dealComment, /Durable synthetic interest/);
    const denied = await call(worker.base, "/review/confirm", { reviewId: review.body.reviewId, revision: review.body.revision });
    assert.equal(denied.status, 403);
    assert.equal((await call(worker.base, "/provider/count", {})).body.calls, 0);
    await stopWorker(worker.child);

    worker = await startWorker(root);
    const recoveredReview = await call(worker.base, "/review/get", { reviewId: review.body.reviewId });
    assert.equal(recoveredReview.status, 200);
    assert.deepEqual(recoveredReview.body.details, review.body.details);
    const confirmed = await call(worker.base, "/review/confirm", { reviewId: review.body.reviewId,
      revision: review.body.revision }, { approval: true });
    assert.equal(confirmed.status, 201, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.status, "created");
    assert.equal(confirmed.body.linkStatus, "linked");
    assert.equal((await call(worker.base, "/provider/count", {})).body.calls, 1);
    const replay = await call(worker.base, "/review/confirm", { reviewId: review.body.reviewId,
      revision: review.body.revision }, { approval: true });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.dealId, confirmed.body.dealId);
    assert.equal((await call(worker.base, "/provider/count", {})).body.calls, 1);
    const operation = await call(worker.base, "/operation/get", { operationId: review.body.operationId });
    assert.equal(operation.body.dealId, confirmed.body.dealId);
    assert.equal((await call(worker.base, "/prelead/context", { exhibitionId: "demo-expo-001", companyId })).body.revision, 2);
    await stopWorker(worker.child);
    worker = await startWorker(root);
    const finalReplay = await call(worker.base, "/review/confirm", { reviewId: review.body.reviewId,
      revision: review.body.revision }, { approval: true });
    assert.equal(finalReplay.status, 200);
    assert.equal(finalReplay.body.dealId, confirmed.body.dealId);
    assert.equal((await call(worker.base, "/provider/count", {})).body.calls, 0);
    const afterDeal = await call(worker.base, "/catalog/bind", { buildId: rebuilt.body.buildId, companyId });
    assert.equal(afterDeal.status, 200);
    assert.equal(afterDeal.body.prelead.disposition, "deal");
  } finally {
    if (worker) await stopWorker(worker.child);
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown built-participant provider outcome is reserved and never retried after restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "crm-built-unknown-d1-"));
  let worker;
  try {
    for (const migration of ["migrations/0001_s04_domain.sql", "migrations/0002_built_catalog.sql"]) {
      const applied = spawnSync(node, [wrangler, "d1", "execute", "CRM_DB", "--config", config,
        "--local", "--persist-to", root, "--file", migration, "--yes", "--json"], { cwd, encoding: "utf8" });
      assert.equal(applied.status, 0, applied.stderr || applied.stdout);
    }
    worker = await startWorker(root);
    const built = await call(worker.base, "/catalog/build", { exhibitionId: "demo-expo-001", idempotencyKey: "durable-unknown" });
    const companyId = (await call(worker.base, "/catalog/read", { buildId: built.body.buildId, classification: "target" })).body.items[0].id;
    await call(worker.base, "/catalog/bind", { buildId: built.body.buildId, companyId });
    const draft = { buildId: built.body.buildId, companyId, exhibitionId: "demo-expo-001",
      title: "Unknown built outcome", companyInn: "0000000001", contactName: "Example Contact",
      dealComment: "Synthetic uncertain outcome" };
    const review = await call(worker.base, "/review/prepare", draft);
    assert.equal(review.status, 201);
    const confirm = { reviewId: review.body.reviewId, revision: review.body.revision };
    const unknown = await call(worker.base, "/review/confirm", confirm, { approval: true });
    assert.equal(unknown.status, 202);
    assert.equal(unknown.body.status, "unknown");
    assert.equal((await call(worker.base, "/provider/count", {})).body.calls, 1);
    await stopWorker(worker.child);
    worker = await startWorker(root);
    const replay = await call(worker.base, "/review/confirm", confirm, { approval: true });
    assert.equal(replay.status, 202);
    assert.equal(replay.body.status, "unknown");
    assert.equal((await call(worker.base, "/provider/count", {})).body.calls, 0);
  } finally {
    if (worker) await stopWorker(worker.child);
    rmSync(root, { recursive: true, force: true });
  }
});
