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
    "0006_connected_browser_mode.sql", "0007_connected_browser_s04_commands.sql",
    "0008_cp_approval_intents.sql", "0009_encrypt_connected_browser_secrets.sql",
    "0010_catalog_v11_artifacts.sql", "0011_catalog_v12_artifacts.sql"]) {
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
const call = (base, path, options = {}) => {
  const headers = new Headers(options.headers);
  if (path.startsWith("/__")) headers.set("x-crm-sandbox-test-key", "local-crm-connected-sandbox-debug-key-20261008");
  return fetch(`${base}${path}`, { redirect: "manual", ...options, headers });
};

test("synthetic fixture controls and encrypted browser storage are not public", async () => {
  const root = mkdtempSync(join(tmpdir(), "crm-connected-browser-debug-"));
  let worker;
  try {
    migrate(root);
    worker = await start(root);
    for (const path of ["/__browser-storage", "/__cp-count", "/__cp-control?mode=outage",
      "/__sandbox-login?view=deal", "/__sandbox-approve"]) {
      const response = await fetch(`${worker.base}${path}`);
      assert.equal(response.status, 404, `${path} must fail closed without the sandbox test key`);
    }
    assert.deepEqual(await (await call(worker.base, "/__cp-count")).json(), {
      cpCalls: 0, foreignEgress: 0, approvalPrepareCalls: 0, approvalConsumeCalls: 0, weeekCreatePosts: 0
    }, "authorized local fixture diagnostics remain available to isolated tests");
  } finally {
    await stop(worker?.child);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Worker Fetch uses atomic D1 browser handoff and real profile-scoped catalog after restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "crm-connected-browser-"));
  let worker;
  try {
    migrate(root);
    worker = await start(root);
    const missingKey = await call(worker.base, "/__missing-encryption-key");
    assert.equal(missingKey.status, 503);
    assert.deepEqual(await missingKey.json(), { error: "connected_browser_unavailable" });
    assert.deepEqual(await (await call(worker.base, "/__cp-count")).json(), {
      cpCalls: 0, foreignEgress: 0, approvalPrepareCalls: 0, approvalConsumeCalls: 0, weeekCreatePosts: 0
    }, "missing encryption key fails closed before external requests or writes");
    const seeded = await (await call(worker.base, "/__seed")).json();
    const { buildId, v11ExhibitionId, v11LinkedBuildId, v11CompanyId, v12CompanyId } = seeded;
    assert.equal(v12CompanyId, v11CompanyId, "versioned catalog preserves participant identity");
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
    const pendingStorage = await (await call(worker.base, "/__browser-storage")).json();
    const pendingBytes = JSON.stringify(pendingStorage.pending);
    assert.equal(pendingStorage.pending.length, 1);
    assert.doesNotMatch(pendingBytes, new RegExp(authorize.searchParams.get("state")));
    assert.match(pendingStorage.pending[0].sealed_payload, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const callback = `/auth/connected/callback?code=${"c".repeat(64)}&state=${authorize.searchParams.get("state")}` +
      `&iss=${encodeURIComponent("https://cp.example.invalid")}`;
    await stop(worker.child);
    worker = await start(root);
    const [accepted, replay] = await Promise.all([call(worker.base, callback, { headers: { cookie: pending } }),
      call(worker.base, callback, { headers: { cookie: pending } })]);
    assert.deepEqual([accepted.status, replay.status].sort(), [303, 401]);
    const session = cookie(accepted.status === 303 ? accepted : replay, "__Host-crm-connected-session");
    assert.match(session, /^__Host-crm-connected-session=[a-f0-9]{64}$/);
    const sessionStorage = await (await call(worker.base, "/__browser-storage")).json();
    assert.equal(sessionStorage.sessions.length, 1);
    assert.doesNotMatch(JSON.stringify(sessionStorage.sessions), /b{64}/,
      "the opaque CP bearer token is not stored as plaintext in D1");
    assert.match(sessionStorage.sessions[0].sealed_payload, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.equal((accepted.status === 303 ? accepted : replay).headers.get("location"),
      `https://crm.example.invalid/catalogs/${buildId}`);
    assert.equal((await call(worker.base, "/auth/connected/start?returnTo=https%3A%2F%2Fevil.example.invalid" )).status, 400);
    assert.equal((await call(worker.base, "/auth/connected/start?returnTo=%2F%2Fevil.example.invalid" )).status, 400);
    await stop(worker.child);
    worker = await start(root);
    const details = await call(worker.base, `/catalogs/${buildId}`, { headers: { cookie: session } });
    assert.equal(details.status, 200);
    assert.match(await details.text(), /Example Machine Works/);
    const v11DeepLink = await call(worker.base, `/catalogs/${v11ExhibitionId}`);
    assert.equal(v11DeepLink.status, 303);
    const v11StartUrl = new URL(v11DeepLink.headers.get("location"));
    const v11Start = await call(worker.base, v11StartUrl.pathname + v11StartUrl.search);
    assert.equal(v11Start.status, 303, await v11Start.clone().text());
    assert.equal(new URL(v11Start.headers.get("location")).searchParams.get("scope"), "crm.catalog.read");
    const v11CallbackUrl = new URL(v11Start.headers.get("location"));
    const v11Callback = await call(worker.base, `/auth/connected/callback?code=${"c".repeat(64)}` +
      `&state=${v11CallbackUrl.searchParams.get("state")}&iss=${encodeURIComponent("https://cp.example.invalid")}`,
      { headers: { cookie: cookie(v11Start, "__Host-crm-connected-pending") } });
    assert.equal(v11Callback.status, 303);
    const v11Session = cookie(v11Callback, "__Host-crm-connected-session");
    const v11Details = await call(worker.base, `/catalogs/${v11ExhibitionId}?revenueBand=100-1500`,
      { headers: { cookie: v11Session } });
    assert.equal(v11Details.status, 200, await v11Details.clone().text());
    const v11Html = await v11Details.text();
    assert.match(v11Html, /Synthetic manufacturing/);
    assert.match(v11Html, /Уплаченные налоги: 1,25 млн ₽ \(2024\)/);
    assert.match(v11Html, /Сотрудники: 42 \(2025\)/);
    assert.match(v11Html, /Директор: Synthetic Director 001 · Synthetic director role/);
    assert.ok(v11Html.includes(`https://t.me/flexi_leads_bot?start=crm1_${v11LinkedBuildId}_${v11CompanyId}`),
      "the profile-scoped catalog emits a stable Telegram participant reference for the linked legacy build");
    assert.equal(v11Html.includes("profile_A"), false, "profile identity is not serialized into the Telegram link");
    const catalogSearch = await call(worker.base, `/api/v1/catalogs/${v11ExhibitionId}/entries?limit=10`,
      { headers: { cookie: v11Session } });
    assert.equal(catalogSearch.status, 200, await catalogSearch.clone().text());
    const catalogSearchBody = await catalogSearch.json();
    assert.equal(catalogSearchBody.total, 1);
    assert.equal(catalogSearchBody.items[0].name, "Synthetic manufacturing");
    assert.equal(catalogSearchBody.artifactVersion, "1.2.0");
    assert.equal(catalogSearchBody.items[0].taxesPaidRub, 1250000);
    assert.equal(catalogSearchBody.items[0].taxesPaidPeriod, "2024");
    assert.equal(catalogSearchBody.items[0].employeeCount, 42);
    assert.equal(catalogSearchBody.items[0].employeePeriod, "2025");
    assert.equal(catalogSearchBody.items[0].directorName, "Synthetic Director 001");
    assert.deepEqual(catalogSearchBody.items[0].directorProvenance, {
      provider: "legacy-ex-snapshot", fixtureRef: catalogSearchBody.sourceRevision });
    await call(worker.base, "/__cp-control?mode=deals_only");
    const noCatalogScope = await call(worker.base, `/api/v1/catalogs/${v11ExhibitionId}/entries`,
      { headers: { cookie: v11Session } });
    assert.equal(noCatalogScope.status, 403, await noCatalogScope.clone().text());
    await call(worker.base, "/__cp-control?mode=active");
    const v11CardPath = `/catalogs/${v11ExhibitionId}/participants/${v11CompanyId}`;
    assert.match(v11Html, new RegExp(v11CardPath.replaceAll("/", "\\/")));
    assert.equal((await call(worker.base, `${v11CardPath}?profileId=profile_B`,
      { headers: { cookie: v11Session } })).status, 400);
    assert.equal((await call(worker.base,
      `/catalogs/${v11ExhibitionId}/participants/co-${"0".repeat(20)}`, { headers: { cookie: v11Session } })).status, 404);
    const v11CardRedirect = await call(worker.base, v11CardPath, { headers: { cookie: v11Session } });
    assert.equal(v11CardRedirect.status, 200, await v11CardRedirect.clone().text());
    const v12ParticipantCard = await v11CardRedirect.text();
    assert.match(v12ParticipantCard, /Synthetic Director 001/);
    assert.match(v12ParticipantCard, /Уплаченные налоги/);
    assert.match(v12ParticipantCard, /Сотрудники/);
    const canonicalCardPath = v12ParticipantCard.match(/href="([^\"]+)"/)?.[1];
    assert.match(canonicalCardPath, /^\/catalogs\/build-[a-f0-9]{24}\/participants\/co-[a-f0-9]{20}$/);
    const canonicalCard = await call(worker.base, canonicalCardPath, { headers: { cookie: v11Session } });
    assert.equal(canonicalCard.status, 200, await canonicalCard.clone().text());
    assert.match(await canonicalCard.text(), /Synthetic manufacturing/);
    const dealScopeHandoff = await call(worker.base, `${canonicalCardPath}/deal`, { headers: { cookie: v11Session } });
    assert.equal(dealScopeHandoff.status, 303);
    const dealScopeUrl = new URL(dealScopeHandoff.headers.get("location"));
    assert.equal(dealScopeUrl.searchParams.get("from"), "dealCreate");
    assert.equal(dealScopeUrl.searchParams.get("returnTo"), `${canonicalCardPath}/deal`);
    assert.equal((await call(worker.base, `/catalogs/${v11ExhibitionId}`, { headers: {
      cookie: session, authorization: `Bearer ${"b".repeat(64)}` } })).status, 400);
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
    assert.doesNotMatch(JSON.stringify(sessionStorage.sessions), new RegExp(csrf),
      "the CSRF secret is not stored as plaintext in D1");
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
    assert.match(reviewHtml, /Перейти к проверке в Control Plane/);
    assert.match(reviewHtml, /После него вернитесь сюда и отдельно отправьте сделку в Weeek/);
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
    assert.equal(unapproved.status, 409, await unapproved.clone().text());
    const approvalPage = await unapproved.text();
    assert.match(approvalPage, /Проверить и подтвердить действие в Control Plane/);
    assert.match(approvalPage, /cp\.example\.invalid\/v1\/connected-app-approvals\/review\?intent=/);
    const approvalCounts = await (await call(worker.base, "/__cp-count")).json();
    assert.equal(approvalCounts.approvalPrepareCalls, 1);
    assert.equal(approvalCounts.approvalConsumeCalls, 1);
    assert.equal(approvalCounts.weeekCreatePosts, 0);
    assert.equal((await (await call(worker.base, "/__cp-count")).json()).weeekCreatePosts, 0,
      "a create scope without a trusted approval receipt cannot reach Weeek");

    await call(worker.base, "/__expire-approval");
    await call(worker.base, "/__cp-control?mode=expired_unconsumed");
    const replacementApproval = await call(worker.base, "/deal-workflow/confirm", { method: "POST",
      headers: { cookie: session, origin: "https://crm.example.invalid",
        "content-type": "application/x-www-form-urlencoded" }, body: confirmationForm });
    assert.equal(replacementApproval.status, 409, await replacementApproval.clone().text());
    assert.match(await replacementApproval.text(), /cp\.example\.invalid\/v1\/connected-app-approvals\/review\?intent=/);
    const replacementCounts = await (await call(worker.base, "/__cp-count")).json();
    assert.equal(replacementCounts.approvalPrepareCalls, 2,
      "an expired unconsumed intent is replaced and requires a new human confirmation");
    assert.equal(replacementCounts.approvalConsumeCalls, 3);
    assert.equal(replacementCounts.weeekCreatePosts, 0);

    await call(worker.base, "/__cp-control?mode=receipt_approved_response_lost");
    const lostReceiptResponse = await call(worker.base, "/deal-workflow/confirm", { method: "POST",
      headers: { cookie: session, origin: "https://crm.example.invalid",
        "content-type": "application/x-www-form-urlencoded" }, body: confirmationForm });
    assert.equal(lostReceiptResponse.status, 503, await lostReceiptResponse.clone().text());
    assert.equal((await (await call(worker.base, "/__cp-count")).json()).weeekCreatePosts, 0,
      "a lost CP consume response cannot reach Weeek before the receipt is recovered");

    // CP receipts remain recoverable for 90 days. Even after the ten-minute
    // approval window, CRM must consume the same intent/request pair before
    // preparing a replacement intent.
    await call(worker.base, "/__expire-approval");
    await call(worker.base, "/__cp-control?mode=receipt_approved");
    const uncertain = await call(worker.base, "/deal-workflow/confirm", { method: "POST",
      headers: { cookie: session, origin: "https://crm.example.invalid",
        "content-type": "application/x-www-form-urlencoded" }, body: confirmationForm });
    assert.equal(uncertain.status, 202, await uncertain.clone().text());
    const uncertainHtml = await uncertain.text();
    assert.match(uncertainHtml, /Результат уточняется/);
    assert.match(uncertainHtml, /Повторного запроса на создание не будет/);
    const operationId = uncertainHtml.match(/name="operationId" value="(op-[0-9a-f-]{36})"/)?.[1];
    assert.ok(operationId);
    const afterReceiptRecovery = await (await call(worker.base, "/__cp-count")).json();
    assert.equal(afterReceiptRecovery.approvalPrepareCalls, 2,
      "receipt recovery must reuse the expired consumed intent instead of requesting another approval");
    assert.equal(afterReceiptRecovery.approvalConsumeCalls, 5);
    assert.equal(afterReceiptRecovery.weeekCreatePosts, 1);

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

test("public sandbox catalog entry uses read-only profile and displays seeded company facts", async () => {
  const root = mkdtempSync(join(tmpdir(), "crm-public-catalog-sandbox-"));
  let worker;
  try {
    migrate(root);
    worker = await start(root);
    const login = await call(worker.base, "/__sandbox-login?view=catalog");
    assert.equal(login.status, 303, await login.clone().text());
    assert.equal(login.headers.get("location"), "/catalogs/synthetic-current-source-shape");
    const session = cookie(login, "__Host-crm-connected-session");
    assert.ok(session);
    const catalog = await call(worker.base, "/catalogs/synthetic-current-source-shape", {
      headers: { cookie: session }
    });
    assert.equal(catalog.status, 200, await catalog.clone().text());
    const html = await catalog.text();
    assert.match(html, /Уплаченные налоги: 1,25 млн ₽ \(2024\)/);
    assert.match(html, /Сотрудники: 42 \(2025\)/);
    assert.match(html, /Директор: Synthetic Director 001 · Synthetic director role/);
    const cardPath = html.match(/href="(\/catalogs\/synthetic-current-source-shape\/participants\/co-[a-f0-9]{20})"/)?.[1];
    assert.ok(cardPath);
    const card = await call(worker.base, cardPath, { headers: { cookie: session } });
    assert.equal(card.status, 200, await card.clone().text());
    const cardHtml = await card.text();
    assert.match(cardHtml, /Synthetic Director 001/);
    const canonicalCardPath = cardHtml.match(/href="(\/catalogs\/build-[a-f0-9]{24}\/participants\/co-[a-f0-9]{20})"/)?.[1];
    assert.ok(canonicalCardPath);
    const dealHandoff = await call(worker.base, `${canonicalCardPath}/deal`, { headers: { cookie: session } });
    assert.equal(dealHandoff.status, 303);
    const dealScopeUrl = new URL(dealHandoff.headers.get("location"));
    assert.equal(dealScopeUrl.searchParams.get("from"), "dealCreate",
      "catalog-only profile must request a separate create scope before preparing a deal");
    const invalidView = await call(worker.base, "/__sandbox-login?view=unrecognized");
    assert.equal(invalidView.status, 400);
    const seededA = await call(worker.base, "/__sandbox-login?view=deal&seed=012345abcdef");
    const seededAReplay = await call(worker.base, "/__sandbox-login?view=deal&seed=012345abcdef");
    const seededB = await call(worker.base, "/__sandbox-login?view=deal&seed=012345abcdee");
    for (const response of [seededA, seededAReplay, seededB]) assert.equal(response.status, 303);
    assert.equal(seededA.headers.get("location"), seededAReplay.headers.get("location"),
      "the same sandbox seed reuses its idempotent synthetic build");
    assert.notEqual(seededA.headers.get("location"), seededB.headers.get("location"),
      "a distinct sandbox seed gets a fresh participant for isolated deal workflows");
    const seededCompanyA = seededA.headers.get("location").match(/\/participants\/(co-[a-f0-9]{20})\/deal$/)?.[1];
    const seededCompanyB = seededB.headers.get("location").match(/\/participants\/(co-[a-f0-9]{20})\/deal$/)?.[1];
    assert.ok(seededCompanyA && seededCompanyB && seededCompanyA !== seededCompanyB,
      "a fresh deal seed must not collide with the prior participant's one-deal limit");
    assert.equal((await call(worker.base, "/__sandbox-login?view=deal&seed=unsafe-seed")).status, 400);
    assert.equal((await call(worker.base, "/__sandbox-login?view=catalog&seed=012345abcdef")).status, 400);
  } finally {
    if (worker) await stop(worker.child);
    rmSync(root, { recursive: true, force: true });
  }
});

test("connected MCP Worker serves the pinned catalog tool through CP introspection and the canonical D1 handler", async () => {
  const root = mkdtempSync(join(tmpdir(), "crm-connected-mcp-"));
  let worker;
  try {
    migrate(root);
    worker = await start(root);
    const seeded = await (await call(worker.base, "/__seed")).json();
    const headers = { accept: "application/json, text/event-stream", "content-type": "application/json",
      authorization: `Bearer ${"b".repeat(64)}`, "mcp-protocol-version": "2025-06-18" };
    const send = async body => call(worker.base, "/mcp", { method: "POST", headers, body: JSON.stringify(body) });
    const initialized = await send({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "runner-test", version: "1" } } });
    assert.equal(initialized.status, 200);
    assert.equal((await initialized.json()).result.protocolVersion, "2025-06-18");
    const listing = await send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const tools = (await listing.json()).result.tools;
    assert.deepEqual(tools.map(tool => tool.name), ["crm_exhibitions_catalog_search",
      "crm_deal_prepare_from_participant", "crm_deal_create_from_participant",
      "crm_deal_get_operation", "crm_deal_reconcile_operation"]);
    assert.equal(tools[0]._meta.capabilityVersion, "1.1.0");
    const result = await send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: {
      name: "crm_exhibitions_catalog_search",
      arguments: { exhibitionId: seeded.v11ExhibitionId, limit: 5, classification: "target",
        country: "Sample Federation", revenueBand: "100-1500", profitBand: "0-30" },
      _meta: { capabilityVersion: "1.1.0" }
    } });
    const content = await result.json();
    assert.equal(result.status, 200);
    assert.equal(content.result.isError, false);
    assert.equal(content.result.structuredContent.artifactVersion, "1.2.0");
    assert.equal(content.result.structuredContent.items[0].taxesPaidRub, 1250000);
    assert.equal(content.result.structuredContent.items[0].employeeCount, 42);
    assert.equal(content.result.structuredContent.items[0].directorName, "Synthetic Director 001");
    assert.equal(result.headers.get("cache-control"), "no-store");
    assert.equal(result.headers.get("mcp-session-id"), null, "Worker MCP stays stateless");

    const unauthorized = await call(worker.base, "/mcp", { method: "POST",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: {
        name: "crm_exhibitions_catalog_search", arguments: { exhibitionId: seeded.v11ExhibitionId },
        _meta: { capabilityVersion: "1.1.0" }
      } }) });
    assert.equal((await unauthorized.json()).error.message, "AUTH_CONTEXT_UNAVAILABLE");

    const cpCount = await (await call(worker.base, "/__cp-count")).json();
    const forgedProfile = await send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: {
      name: "crm_exhibitions_catalog_search",
      arguments: { exhibitionId: seeded.v11ExhibitionId, profileId: "profile_B" },
      _meta: { capabilityVersion: "1.1.0" }
    } });
    assert.equal((await forgedProfile.json()).error.message, "INVALID_ARGUMENTS");
    assert.equal((await (await call(worker.base, "/__cp-count")).json()).cpCalls, cpCount.cpCalls,
      "forged profile args fail before CP identity resolution");

    await call(worker.base, "/__cp-control?mode=deals_only");
    const denied = await send({ jsonrpc: "2.0", id: 6, method: "tools/call", params: {
      name: "crm_exhibitions_catalog_search", arguments: { exhibitionId: seeded.v11ExhibitionId },
      _meta: { capabilityVersion: "1.1.0" }
    } });
    assert.equal((await denied.json()).error.message, "SCOPE_DENIED");
    await call(worker.base, "/__cp-control?mode=active");
  } finally {
    if (worker) await stop(worker.child);
    rmSync(root, { recursive: true, force: true });
  }
});

test("connected MCP S-04 routes profile-bound deal methods through canonical handlers and requires CP approval", async () => {
  const root = mkdtempSync(join(tmpdir(), "crm-connected-mcp-s04-"));
  let worker;
  try {
    migrate(root);
    worker = await start(root);
    const seed = await call(worker.base, "/__sandbox-login?view=deal&seed=012345abcdef");
    assert.equal(seed.status, 303);
    const participantUrl = new URL(seed.headers.get("location"), worker.base);
    const [, buildId, companyId] = participantUrl.pathname.match(/^\/catalogs\/(build-[a-f0-9]{24})\/participants\/(co-[a-f0-9]{20})\/deal$/) ?? [];
    assert.ok(buildId && companyId, participantUrl.pathname);
    const diagnostic = await (await call(worker.base,
      `/__deal-diagnostics?buildId=${buildId}&companyId=${companyId}`)).json();
    assert.deepEqual(diagnostic, { selectedStatus: 200, selectedError: null, preleadStatus: 200,
      preleadError: null, resolved: true, contextFound: true, selectedExhibitionId: "demo-expo-001",
      selectedCompanyId: companyId });

    const headers = { accept: "application/json, text/event-stream", "content-type": "application/json",
      authorization: `Bearer ${"b".repeat(64)}`, "mcp-protocol-version": "2025-06-18" };
    const send = (id, name, args, version = "1.0.0") => call(worker.base, "/mcp", { method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: {
        name, arguments: args, _meta: { capabilityVersion: version } } }) });
    const args = { buildId, companyId, exhibitionId: "demo-expo-001", title: "Synthetic sandbox deal",
      companyInn: "0000000001", contactName: "Synthetic Contact", dealComment: "Synthetic MCP review." };

    const forgedProfile = await send(1, "crm_deal_prepare_from_participant", { ...args, profileId: "profile_B" });
    assert.equal((await forgedProfile.json()).error.message, "INVALID_ARGUMENTS");
    await call(worker.base, "/__cp-control?mode=deals_only");
    const denied = await send(2, "crm_deal_prepare_from_participant", args);
    assert.equal((await denied.json()).error.message, "SCOPE_DENIED");
    await call(worker.base, "/__cp-control?mode=profile_B");
    const foreign = await send(3, "crm_deal_prepare_from_participant", args);
    assert.equal((await foreign.json()).error.message, "NOT_FOUND");
    await call(worker.base, "/__cp-control?mode=deal_create");

    const preparedResponse = await send(4, "crm_deal_prepare_from_participant", args);
    const preparedBody = await preparedResponse.json();
    assert.ok(preparedBody.result, JSON.stringify(preparedBody));
    const prepared = preparedBody.result.structuredContent;
    assert.equal(prepared.status, "prepared");
    assert.equal(prepared.details.companyId, companyId);
    const beforeApproval = await (await call(worker.base, "/__cp-count")).json();
    assert.equal(beforeApproval.weeekCreatePosts, 0);

    const confirmArgs = { reviewId: prepared.reviewId, revision: prepared.revision };
    const approvalRequired = await send(5, "crm_deal_create_from_participant", confirmArgs);
    const pending = (await approvalRequired.json()).result;
    assert.equal(pending.isError, false);
    assert.equal(pending._meta.outcome, "pending");
    assert.equal(pending.structuredContent.error, "human_approval_required");
    assert.match(pending.structuredContent.approvalUrl, /^https:\/\/cp\.example\.invalid\/v1\/connected-app-approvals\/review\?intent=/);
    assert.equal((await (await call(worker.base, "/__cp-count")).json()).weeekCreatePosts, 0);

    await call(worker.base, "/__sandbox-approve");
    const accepted = await send(6, "crm_deal_create_from_participant", confirmArgs);
    const unknown = (await accepted.json()).result;
    assert.equal(unknown.isError, false);
    assert.equal(unknown._meta.outcome, "pending");
    assert.equal(unknown.structuredContent.status, "unknown");
    const operationId = prepared.operationId;
    const reconciledResponse = await send(7, "crm_deal_reconcile_operation", { operationId });
    const reconciled = (await reconciledResponse.json()).result.structuredContent;
    assert.equal(reconciled.status, "created");
    assert.equal(reconciled.linkStatus, "linked");
    const final = await send(8, "crm_deal_get_operation", { operationId });
    assert.equal((await final.json()).result.structuredContent.dealId, reconciled.dealId);
    const counts = await (await call(worker.base, "/__cp-count")).json();
    assert.equal(counts.weeekCreatePosts, 1, "unknown provider response is reconciled without a second create");
    assert.equal(counts.foreignEgress, 0);
  } finally {
    if (worker) await stop(worker.child);
    rmSync(root, { recursive: true, force: true });
  }
});
