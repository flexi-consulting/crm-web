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
    "0004_legacy_catalog_refs.sql", "0005_connected_browser_sessions.sql",
    "0006_connected_browser_mode.sql", "0007_connected_browser_s04_commands.sql"]) {
    const result = spawnSync(node, [wrangler, "d1", "execute", "CRM_DB", "--config", config,
      "--local", "--persist-to", root, "--file", `migrations/${file}`, "--yes", "--json"],
    { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  const providerFixture = spawnSync(node, [wrangler, "d1", "execute", "WEEEK_FIXTURE_DB", "--config", config,
    "--local", "--persist-to", root, "--file", "test/fixtures/weeek-http-provider.sql", "--yes", "--json"],
  { cwd, encoding: "utf8" });
  assert.equal(providerFixture.status, 0, providerFixture.stderr || providerFixture.stdout);
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
    assert.equal(new URL(deepLink.headers.get("location")).searchParams.get("from"), "catalog");
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
      { method: "POST", headers: { cookie: session } })).status, 403);
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
    const expiringStart = await call(worker.base, "/auth/connected/start?from=catalog");
    const expiringTarget = new URL(expiringStart.headers.get("location"));
    const expiringPending = cookie(expiringStart, "__Host-crm-connected-pending");
    await call(worker.base, "/__clock-offset?milliseconds=301000");
    const expired = await call(worker.base, `/auth/connected/callback?code=${"c".repeat(64)}` +
      `&state=${expiringTarget.searchParams.get("state")}&iss=${encodeURIComponent("https://cp.example.invalid")}`,
    { headers: { cookie: expiringPending } });
    assert.equal(expired.status, 401);
    await call(worker.base, "/__clock-offset?milliseconds=0");
    const sessionStart = await call(worker.base, "/auth/connected/start?from=catalog");
    const sessionTarget = new URL(sessionStart.headers.get("location"));
    const sessionCallback = await call(worker.base, `/auth/connected/callback?code=${"c".repeat(64)}` +
      `&state=${sessionTarget.searchParams.get("state")}&iss=${encodeURIComponent("https://cp.example.invalid")}`,
    { headers: { cookie: cookie(sessionStart, "__Host-crm-connected-pending") } });
    assert.equal(sessionCallback.status, 303);
    const expiringSession = cookie(sessionCallback, "__Host-crm-connected-session");
    await call(worker.base, "/__clock-offset?milliseconds=301000");
    assert.equal((await call(worker.base, `/catalogs/${buildId}`,
      { headers: { cookie: expiringSession } })).status, 401);
    await call(worker.base, "/__clock-offset?milliseconds=0");
    await call(worker.base, "/__cp-control?mode=deals_only");
    const dealStart = await call(worker.base, "/auth/connected/start?from=deals");
    assert.equal(dealStart.status, 303);
    const dealTarget = new URL(dealStart.headers.get("location"));
    assert.equal(dealTarget.searchParams.get("scope"), "crm.deals.read");
    const dealCallback = await call(worker.base, `/auth/connected/callback?code=${"c".repeat(64)}` +
      `&state=${dealTarget.searchParams.get("state")}&iss=${encodeURIComponent("https://cp.example.invalid")}`,
    { headers: { cookie: cookie(dealStart, "__Host-crm-connected-pending") } });
    assert.equal(dealCallback.status, 303);
    const dealSession = cookie(dealCallback, "__Host-crm-connected-session");
    assert.equal((await call(worker.base, "/deals", { headers: { cookie: dealSession } })).status, 200);
    assert.equal((await call(worker.base, `/catalogs/${buildId}`, { headers: { cookie: dealSession } })).status, 403);
    await call(worker.base, "/__cp-control?mode=catalog_only");
    const deniedDeal = await call(worker.base, "/deals", { headers: { cookie: dealSession } });
    assert.equal(deniedDeal.status, 303);
    assert.equal(new URL(deniedDeal.headers.get("location")).searchParams.get("from"), "deals");
    assert.equal((await call(worker.base, "/auth/connected/start")).status, 200);
    const catalogStart = await call(worker.base, "/auth/connected/start?from=catalog");
    assert.equal(new URL(catalogStart.headers.get("location")).searchParams.get("scope"), "crm.catalog.read");
  } finally {
    if (worker) await stop(worker.child);
    rmSync(root, { recursive: true, force: true });
  }
});

test("browser S-04 confirms through D1 and Weeek HTTP, then reconciles an accepted timeout without a second POST", async () => {
  const root = mkdtempSync(join(tmpdir(), "crm-connected-s04-browser-"));
  let worker;
  try {
    migrate(root);
    worker = await start(root);
    const seeded = await (await call(worker.base, "/__seed")).json();
    const dealPath = `/catalogs/${seeded.buildId}/participants/${seeded.companyId}/deal`;
    const stepUp = await call(worker.base, dealPath);
    assert.equal(stepUp.status, 303);
    const stepUpUrl = new URL(stepUp.headers.get("location"));
    assert.equal(stepUpUrl.pathname, "/auth/connected/start");
    assert.equal(stepUpUrl.searchParams.get("from"), "dealCreate");
    assert.equal(stepUpUrl.searchParams.get("returnTo"), dealPath);
    await call(worker.base, "/__cp-control?mode=deal_create");
    const authorization = await call(worker.base, `${stepUpUrl.pathname}${stepUpUrl.search}`);
    assert.equal(authorization.status, 303, await authorization.clone().text());
    const target = new URL(authorization.headers.get("location"));
    assert.equal(target.searchParams.get("scope"), "crm.deals.create");
    const pending = cookie(authorization, "__Host-crm-connected-pending");
    const callbackPath = `/auth/connected/callback?code=${"c".repeat(64)}&state=${target.searchParams.get("state")}` +
      `&iss=${encodeURIComponent("https://cp.example.invalid")}`;
    const callback = await call(worker.base, callbackPath, { headers: { cookie: pending } });
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get("location"), `https://crm.example.invalid${dealPath}`);
    const session = cookie(callback, "__Host-crm-connected-session");
    const formPage = await call(worker.base, dealPath, { headers: { cookie: session } });
    assert.equal(formPage.status, 200, `${await formPage.clone().text()}\n${worker.getLogs()}`);
    const formHtml = await formPage.text();
    assert.match(formHtml, /Подготовить сводку/);
    const csrf = formHtml.match(/name="_csrf" value="([a-f0-9]{64})"/)?.[1];
    assert.ok(csrf);

    const draft = { buildId: seeded.buildId, companyId: seeded.companyId, exhibitionId: seeded.exhibitionId,
      title: `Встреча с ${seeded.companyName}`, companyInn: "7701234567", contactName: "Synthetic Contact",
      dealComment: "Discuss the catalog participation." };
    const apiPrepare = await call(worker.base, "/api/v1/deal-reviews", { method: "POST",
      headers: { cookie: session, origin: "https://crm.example.invalid", "x-csrf-token": csrf,
        "content-type": "application/json" }, body: JSON.stringify(draft) });
    assert.equal(apiPrepare.status, 201);
    assert.equal((await apiPrepare.json()).status, "prepared");
    assert.equal((await call(worker.base, "/api/v1/deal-reviews", { method: "POST",
      headers: { cookie: session, "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify(draft) })).status, 403, "JSON mutation requires exact Origin");

    const prepare = await call(worker.base, "/deal-workflow/prepare", { method: "POST",
      headers: { cookie: session, origin: "https://crm.example.invalid",
        "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...draft, _csrf: csrf }) });
    assert.equal(prepare.status, 201);
    const reviewHtml = await prepare.text();
    assert.match(reviewHtml, /Проверьте данные сделки/);
    assert.match(reviewHtml, /status-lead-A/);
    const reviewId = reviewHtml.match(/name="reviewId" value="(review-[0-9a-f-]{36})"/)?.[1];
    const revision = reviewHtml.match(/name="revision" value="([0-9a-f]{64})"/)?.[1];
    assert.ok(reviewId && revision);
    const confirmationForm = new URLSearchParams({ _csrf: csrf, reviewId, revision });
    assert.equal((await call(worker.base, "/deal-workflow/confirm", { method: "POST",
      headers: { cookie: session, origin: "https://evil.example.invalid",
        "content-type": "application/x-www-form-urlencoded" }, body: confirmationForm })).status, 403);
    assert.equal((await (await call(worker.base, "/__cp-count")).json()).weeekCreatePosts, 0);

    await call(worker.base, "/__cp-control?mode=deal_create_no_approval");
    const unapproved = await call(worker.base, "/deal-workflow/confirm", { method: "POST",
      headers: { cookie: session, origin: "https://crm.example.invalid",
        "content-type": "application/x-www-form-urlencoded" }, body: confirmationForm });
    assert.equal(unapproved.status, 403, await unapproved.clone().text());
    assert.equal((await (await call(worker.base, "/__cp-count")).json()).weeekCreatePosts, 0,
      "a create scope without a trusted approval receipt cannot reach Weeek");

    await call(worker.base, "/__cp-control?mode=deal_create_approved_fixture");
    const uncertain = await call(worker.base, "/deal-workflow/confirm", { method: "POST",
      headers: { cookie: session, origin: "https://crm.example.invalid",
        "content-type": "application/x-www-form-urlencoded" }, body: confirmationForm });
    assert.equal(uncertain.status, 202);
    const uncertainHtml = await uncertain.text();
    assert.match(uncertainHtml, /Результат уточняется/);
    assert.match(uncertainHtml, /Повторного запроса на создание не будет/);
    const operationId = uncertainHtml.match(/name="operationId" value="(op-[0-9a-f-]{36})"/)?.[1];
    assert.ok(operationId);
    assert.equal((await (await call(worker.base, "/__cp-count")).json()).weeekCreatePosts, 1);

    await stop(worker.child);
    worker = await start(root);
    await call(worker.base, "/__cp-control?mode=deal_create_no_approval");
    // The recovery form survives restart and reconciles the existing unknown operation.
    const recovered = await call(worker.base, "/deal-workflow/reconcile", { method: "POST",
      headers: { cookie: session, origin: "https://crm.example.invalid",
        "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: csrf, operationId }) });
    assert.equal(recovered.status, 200, await recovered.clone().text());
    assert.match(await recovered.text(), /Сделка создана/);
    // A delayed duplicate of the explicit confirmation observes the durable result.
    const duplicateConfirm = await call(worker.base, "/deal-workflow/confirm", { method: "POST",
      headers: { cookie: session, origin: "https://crm.example.invalid",
        "content-type": "application/x-www-form-urlencoded" }, body: confirmationForm });
    assert.equal(duplicateConfirm.status, 200);
    assert.match(await duplicateConfirm.text(), /Сделка создана/);
    const operation = await call(worker.base, `/api/v1/deal-operations/${operationId}`,
      { headers: { cookie: session } });
    assert.equal(operation.status, 200);
    const savedOperation = await operation.json();
    assert.equal(savedOperation.status, "created");
    assert.equal(savedOperation.linkStatus, "linked");
    assert.equal(savedOperation.dealId, "weeek_deal_opaque_001");
    const counts = await (await call(worker.base, "/__cp-count")).json();
    assert.equal(counts.weeekCreatePosts, 1);
    assert.equal(counts.foreignEgress, 0);
  } finally {
    if (worker) await stop(worker.child);
    rmSync(root, { recursive: true, force: true });
  }
});
