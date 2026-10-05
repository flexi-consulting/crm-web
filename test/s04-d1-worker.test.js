import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

const wrangler = new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url).pathname;
const compatibleNode = process.env.CRM_S04_WRANGLER_NODE || process.execPath;
const cwd = new URL("..", import.meta.url).pathname;
const config = "test/wrangler.s04-local.toml";
const migration = "migrations/0001_s04_domain.sql";
const now = "2026-10-06T09:00:00.000Z";
const expiresAt = "2027-01-01T00:00:00.000Z";
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ids = (n) => ({ preleadId: `prelead-${uuid(n)}`, reviewId: `review-${uuid(n)}`,
  receiptId: `receipt-${uuid(n)}`, operationId: `op-${uuid(n)}` });
const fixture = (n, eventId = `demo-expo-${String(n).padStart(3, "0")}`) => ({
  ...ids(n), profileRef: "demo-profile-a", eventId, companyId: `demo-company-${String(n).padStart(3, "0")}`,
  revision: "a".repeat(64), requestHash: "b".repeat(64), now, expiresAt
});

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function startWorker(root) {
  const port = await freePort();
  const child = spawn(compatibleNode, [wrangler, "dev", "--config", config, "--ip", "127.0.0.1",
    "--port", String(port), "--persist-to", root, "--log-level", "error"], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
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
async function call(base, path, body) {
  const response = await fetch(`${base}${path}`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
}
async function reviewedCall(base, path, body, { profile = "demo-profile-a", approval = false } = {}) {
  const response = await fetch(`${base}${path}`, { method: "POST", headers: {
    "content-type": "application/json", "x-test-profile": profile,
    ...(approval ? { "x-test-approval": "approved" } : {}) }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

test("reviewed S-04 HTTP contract persists trusted approval, survives restart, and never retries unknown", async () => {
  const root = mkdtempSync(join(tmpdir(), "crm-s04-reviewed-d1-"));
  let running;
  const draft = { companyId: "demo-company-001", exhibitionId: "demo-expo-001",
    title: "Synthetic catalog deal", companyInn: "1234567890", contactName: "Example Person",
    dealComment: "Asked for catalog" };
  try {
    const migrated = spawnSync(compatibleNode, [wrangler, "d1", "execute", "CRM_DB", "--config", config,
      "--local", "--persist-to", root, "--file", migration, "--yes", "--json"], { cwd, encoding: "utf8" });
    assert.equal(migrated.status, 0, migrated.stderr || migrated.stdout);
    running = await startWorker(root);
    await call(running.base, "/seed-prelead", { preleadId: "prelead-reviewed-a",
      profileRef: "demo-profile-a", eventId: draft.exhibitionId, companyId: draft.companyId });
    const prepared = await reviewedCall(running.base, "/review/prepare", draft);
    assert.equal(prepared.status, 201, JSON.stringify(prepared.body));
    assert.equal(prepared.body.details.statusId, "demo-status-lead-a");
    const confirmation = { reviewId: prepared.body.reviewId, revision: prepared.body.revision };
    assert.equal((await reviewedCall(running.base, "/review/confirm", { ...confirmation,
      confirmation: true })).status, 400);
    assert.equal((await reviewedCall(running.base, "/review/confirm", confirmation)).status, 403);
    assert.equal((await reviewedCall(running.base, "/review/get", { reviewId: prepared.body.reviewId },
      { profile: "demo-profile-b" })).status, 404);
    assert.equal((await reviewedCall(running.base, "/provider-count", {})).body.calls, 0);
    assert.equal((await reviewedCall(running.base, "/review/confirm", confirmation,
      { profile: "demo-profile-b", approval: true })).status, 404);
    const created = await reviewedCall(running.base, "/review/confirm", confirmation, { approval: true });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.status, "created");
    assert.equal(created.body.linkStatus, "linked");
    assert.equal((await reviewedCall(running.base, "/provider-count", {})).body.calls, 1);
    const replay = await reviewedCall(running.base, "/review/confirm", confirmation, { approval: true });
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.replayed, true);
    assert.equal((await reviewedCall(running.base, "/provider-count", {})).body.calls, 1);
    await stopWorker(running.child);
    running = await startWorker(root);
    const afterRestart = await reviewedCall(running.base, "/review/get", { reviewId: prepared.body.reviewId });
    assert.equal(afterRestart.body.status, "created");
    assert.equal(afterRestart.body.dealId, created.body.dealId);
    assert.equal((await reviewedCall(running.base, "/review/confirm", confirmation,
      { approval: true })).body.replayed, true);
    assert.equal((await reviewedCall(running.base, "/provider-count", {})).body.calls, 0);
    const staleDraft = { ...draft, title: "Changed revision" };
    const stale = await reviewedCall(running.base, "/review/prepare", staleDraft);
    assert.equal(stale.status, 201);
    assert.equal((await reviewedCall(running.base, "/review/confirm",
      { reviewId: stale.body.reviewId, revision: "0".repeat(64) }, { approval: true })).status, 409);
    await call(running.base, "/advance-prelead", { preleadId: "prelead-reviewed-a" });
    assert.equal((await reviewedCall(running.base, "/review/confirm",
      { reviewId: stale.body.reviewId, revision: stale.body.revision }, { approval: true })).status, 409);
    const unknownDraft = { ...draft, companyId: "demo-company-002",
      exhibitionId: "demo-expo-002", title: "Unknown outcome" };
    await call(running.base, "/seed-prelead", { preleadId: "prelead-reviewed-b",
      profileRef: "demo-profile-b", eventId: unknownDraft.exhibitionId,
      companyId: unknownDraft.companyId });
    const pendingReview = await reviewedCall(running.base, "/review/prepare", unknownDraft,
      { profile: "demo-profile-b" });
    assert.equal(pendingReview.status, 201);
    const unknownRequest = { reviewId: pendingReview.body.reviewId,
      revision: pendingReview.body.revision };
    const unknown = await reviewedCall(running.base, "/review/confirm", unknownRequest,
      { profile: "demo-profile-b", approval: true });
    assert.equal(unknown.status, 202, JSON.stringify(unknown.body));
    assert.equal(unknown.body.status, "unknown");
    await stopWorker(running.child);
    running = await startWorker(root);
    const retry = await reviewedCall(running.base, "/review/confirm", unknownRequest,
      { profile: "demo-profile-b", approval: true });
    assert.equal(retry.status, 202, JSON.stringify(retry.body));
    assert.equal(retry.body.replayed, true);
    assert.equal((await reviewedCall(running.base, "/provider-count", {})).body.calls, 0);
  } finally {
    if (running) await stopWorker(running.child);
    rmSync(root, { recursive: true, force: true });
  }
});

test("local Worker D1 reserves once, survives restart, and links only a verified deal atomically", async () => {
  const root = mkdtempSync(join(tmpdir(), "crm-s04-d1-"));
  let running;
  try {
    const migrated = spawnSync(compatibleNode, [wrangler, "d1", "execute", "CRM_DB", "--config", config,
      "--local", "--persist-to", root, "--file", migration, "--yes", "--json"], { cwd, encoding: "utf8" });
    assert.equal(migrated.status, 0, migrated.stderr || migrated.stdout);
    running = await startWorker(root);
    const a = fixture(1);
    await call(running.base, "/seed", a);
    const b = { ...a, reviewId: `review-${uuid(2)}`, receiptId: `receipt-${uuid(2)}`, operationId: `op-${uuid(2)}` };
    await call(running.base, "/seed-review", b);
    const [first, second] = await Promise.all([
      call(running.base, "/reserve", a), call(running.base, "/reserve", b)
    ]);
    assert.equal([first, second].filter((item) => item.status === "reserved_unknown").length, 1);
    assert.equal([first, second].filter((item) => item.status === "participant_deal_exists").length, 1);
    const winner = first.status === "reserved_unknown" ? a : b;
    assert.equal((await call(running.base, "/reserve", winner)).status, "replay");
    assert.equal((await call(running.base, "/get", { profileRef: "demo-profile-b", operationId: winner.operationId })), null);
    await stopWorker(running.child);
    running = await startWorker(root);
    assert.equal((await call(running.base, "/get", winner)).status, "unknown");
    assert.equal((await call(running.base, "/reserve", winner)).status, "replay");
    assert.equal((await call(running.base, "/link", winner)).status, "created_deal_required");
    assert.equal((await call(running.base, "/created", { ...winner, dealId: "invalid" })).status, "invalid_deal_id");
    const dealId = `demo-deal-${winner.operationId.slice(3)}`;
    assert.equal((await call(running.base, "/created", { ...winner, dealId })).status, "created");
    assert.equal((await call(running.base, "/created", { ...winner, dealId })).status, "replay");
    assert.equal((await call(running.base, "/get", winner)).linkStatus, "pending");
    await call(running.base, "/fail-link-update", {});
    assert.equal((await call(running.base, "/link", winner)).status, "link_conflict");
    assert.deepEqual((await call(running.base, "/events", winner)).events, []);
    assert.equal((await call(running.base, "/get", winner)).linkStatus, "pending");
    await call(running.base, "/clear-fail-link-update", {});
    assert.equal((await call(running.base, "/link", winner)).status, "linked");
    assert.equal((await call(running.base, "/link", winner)).status, "replay");
    const linked = await call(running.base, "/events", winner);
    assert.equal(linked.events.length, 1);
    assert.equal(linked.events[0].kind, "deal_linked");
    assert.equal(JSON.parse(linked.events[0].payload_json).dealId, dealId);
    assert.equal(linked.revision, 1);
    assert.equal((await call(running.base, "/get", winner)).linkStatus, "linked");
    const stale = fixture(3);
    await call(running.base, "/seed", stale);
    await call(running.base, "/advance-prelead", stale);
    assert.equal((await call(running.base, "/reserve", stale)).status, "review_or_receipt_invalid");
    assert.equal((await call(running.base, "/get", stale)), null);
  } finally {
    if (running) await stopWorker(running.child);
    rmSync(root, { recursive: true, force: true });
  }
});
