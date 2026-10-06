import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

const cwd = new URL("..", import.meta.url).pathname;
const wrangler = new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url).pathname;
const config = "test/wrangler.connected-browser-local.toml";
const node = process.execPath;
const freePort = async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
};
async function start(root) {
  const port = await freePort(), inspectorPort = await freePort();
  const child = spawn(node, [wrangler, "dev", "--config", config, "--ip", "127.0.0.1",
    "--port", String(port), "--inspector-port", String(inspectorPort), "--persist-to", root,
    "--log-level", "error"], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout.on("data", (value) => { logs += value; });
  child.stderr.on("data", (value) => { logs += value; });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Worker exited: ${logs}`);
    try { if ((await fetch(`${base}/health`)).ok) return { child, base, getLogs: () => logs }; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  child.kill("SIGTERM"); throw new Error(`Worker did not start: ${logs}`);
}
async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => child.once("close", resolve)),
    new Promise((resolve) => setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 3000))]);
}
function migrate(root) {
  for (const file of ["0001_s04_domain.sql", "0002_built_catalog.sql", "0003_weeek_deal_identity.sql",
    "0004_legacy_catalog_refs.sql", "0005_connected_browser_sessions.sql"]) {
    const result = spawnSync(node, [wrangler, "d1", "execute", "CRM_DB", "--config", config,
      "--local", "--persist-to", root, "--file", `migrations/${file}`, "--yes", "--json"],
    { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
}
const cookie = (response, name) => response.headers.getSetCookie()
  .map((part) => part.split(";")[0]).find((part) => part.startsWith(`${name}=`));
const call = (base, path, options = {}) => fetch(`${base}${path}`, { redirect: "manual", ...options });

test("Worker Fetch uses atomic D1 browser handoff and real profile-scoped catalog after restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "crm-connected-browser-"));
  let worker;
  try {
    migrate(root);
    worker = await start(root);
    const { buildId } = await (await call(worker.base, "/__seed")).json();
    const deepLink = await call(worker.base, `/catalogs/${buildId}`);
    assert.equal(deepLink.status, 303);
    assert.equal(new URL(deepLink.headers.get("location")).searchParams.get("returnTo"), `/catalogs/${buildId}`);
    const startResponse = await call(worker.base, new URL(deepLink.headers.get("location")).pathname +
      new URL(deepLink.headers.get("location")).search);
    assert.equal(startResponse.status, 303, await startResponse.clone().text());
    const authorize = new URL(startResponse.headers.get("location"));
    assert.equal(authorize.origin, "https://cp.example.invalid");
    assert.equal(authorize.searchParams.get("redirect_uri"), "https://crm.example.invalid/auth/connected/callback");
    const pending = cookie(startResponse, "__Host-crm-connected-pending");
    const callback = `/auth/connected/callback?code=${"c".repeat(64)}&state=${authorize.searchParams.get("state")}` +
      `&iss=${encodeURIComponent("https://cp.example.invalid")}`;
    await stop(worker.child);
    worker = await start(root);
    const [accepted, replay] = await Promise.all([call(worker.base, callback, { headers: { cookie: pending } }),
      call(worker.base, callback, { headers: { cookie: pending } })]);
    assert.deepEqual([accepted.status, replay.status].sort(), [303, 401]);
    const session = cookie(accepted.status === 303 ? accepted : replay, "__Host-crm-connected-session");
    assert.match(session, /^__Host-crm-connected-session=[a-f0-9]{64}$/);
    assert.equal((accepted.status === 303 ? accepted : replay).headers.get("location"),
      `https://crm.example.invalid/catalogs/${buildId}`);
    assert.equal((await call(worker.base, "/auth/connected/start?returnTo=https%3A%2F%2Fevil.example.invalid" )).status, 400);
    assert.equal((await call(worker.base, "/auth/connected/start?returnTo=%2F%2Fevil.example.invalid" )).status, 400);
    await stop(worker.child);
    worker = await start(root);
    const details = await call(worker.base, `/catalogs/${buildId}`, { headers: { cookie: session } });
    assert.equal(details.status, 200);
    assert.match(await details.text(), /Example Machine Works/);
    const missingReview = await call(worker.base,
      "/api/v1/deal-reviews/review-11111111-1111-1111-1111-111111111111",
    { headers: { cookie: session } });
    assert.equal(missingReview.status, 404);
    assert.deepEqual(await missingReview.json(), { error: "review_not_found" });
    assert.equal((await call(worker.base, `/catalogs/${buildId}?profileId=other`,
      { headers: { cookie: session } })).status, 400);
    assert.equal((await call(worker.base, `/catalogs/${buildId}`, { headers: {
      cookie: session, authorization: `Bearer ${"b".repeat(64)}` } })).status, 400);
    assert.equal((await call(worker.base, "/api/v1/deal-reviews/review-11111111-1111-1111-1111-111111111111/confirm",
      { method: "POST", headers: { cookie: session } })).status, 404);
    const metadata = await call(worker.base, "/auth/connected/session", { headers: { cookie: session } });
    assert.equal(metadata.status, 200);
    const csrf = (await metadata.json()).csrfToken;
    await call(worker.base, "/__cp-control?mode=revoked");
    assert.equal((await call(worker.base, `/catalogs/${buildId}`, { headers: { cookie: session } })).status, 401);
    await call(worker.base, "/__cp-control?mode=active");
    assert.equal((await call(worker.base, "/auth/connected/logout", { method: "POST",
      headers: { cookie: session, origin: "https://crm.example.invalid" } })).status, 403);
    await call(worker.base, "/__cp-control?mode=outage");
    assert.equal((await call(worker.base, `/catalogs/${buildId}`, { headers: { cookie: session } })).status, 503);
    assert.equal((await call(worker.base, "/auth/connected/logout", { method: "POST",
      headers: { cookie: session, origin: "https://crm.example.invalid", "x-csrf-token": csrf } })).status, 204);
    assert.equal((await call(worker.base, `/catalogs/${buildId}`, { headers: { cookie: session } })).status, 401);
    const counts = await (await call(worker.base, "/__cp-count")).json();
    assert.equal(counts.foreignEgress, 0);
    assert.ok(counts.cpCalls >= 3);
    await call(worker.base, "/__cp-control?mode=active");
    const expiringStart = await call(worker.base, "/auth/connected/start");
    const expiringTarget = new URL(expiringStart.headers.get("location"));
    const expiringPending = cookie(expiringStart, "__Host-crm-connected-pending");
    await call(worker.base, "/__clock-offset?milliseconds=301000");
    const expired = await call(worker.base, `/auth/connected/callback?code=${"c".repeat(64)}` +
      `&state=${expiringTarget.searchParams.get("state")}&iss=${encodeURIComponent("https://cp.example.invalid")}`,
    { headers: { cookie: expiringPending } });
    assert.equal(expired.status, 401);
    await call(worker.base, "/__clock-offset?milliseconds=0");
    const sessionStart = await call(worker.base, "/auth/connected/start");
    const sessionTarget = new URL(sessionStart.headers.get("location"));
    const sessionCallback = await call(worker.base, `/auth/connected/callback?code=${"c".repeat(64)}` +
      `&state=${sessionTarget.searchParams.get("state")}&iss=${encodeURIComponent("https://cp.example.invalid")}`,
    { headers: { cookie: cookie(sessionStart, "__Host-crm-connected-pending") } });
    assert.equal(sessionCallback.status, 303);
    const expiringSession = cookie(sessionCallback, "__Host-crm-connected-session");
    await call(worker.base, "/__clock-offset?milliseconds=301000");
    assert.equal((await call(worker.base, `/catalogs/${buildId}`,
      { headers: { cookie: expiringSession } })).status, 401);
  } finally {
    if (worker) await stop(worker.child);
    rmSync(root, { recursive: true, force: true });
  }
});
