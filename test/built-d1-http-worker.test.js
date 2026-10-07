import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const wrangler = new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url).pathname;
const node = process.env.CRM_S04_WRANGLER_NODE || process.execPath;
const cwd = new URL("..", import.meta.url).pathname;
const config = "test/wrangler.built-d1-http-local.toml";
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function start(root) {
  const port = await freePort(), inspectorPort = await freePort();
  const child = spawn(node, [wrangler, "dev", "--config", config, "--ip", "127.0.0.1",
    "--port", String(port), "--inspector-port", String(inspectorPort),
    "--persist-to", root, "--log-level", "error"], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout.on("data", (part) => { logs += part; });
  child.stderr.on("data", (part) => { logs += part; });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Worker exited: ${logs}`);
    try { if ((await fetch(`${base}/health`)).ok) return { child, base }; } catch {}
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
async function request(base, method, path, body, { profile = "demo-profile-a", approval = false,
  key, scopes, disabled = false } = {}) {
  const response = await fetch(`${base}${path}`, { method, headers: {
    "x-test-profile": profile, ...(approval ? { "x-test-approval": "approved" } : {}),
    ...(key ? { "idempotency-key": key } : {}), ...(scopes ? { "x-test-scopes": scopes.join(",") } : {}),
    ...(disabled ? { "x-test-disable": "true" } : {}),
    ...(body === undefined ? {} : { "content-type": "application/json" })
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
function migrate(root) {
  for (const migration of ["migrations/0001_s04_domain.sql", "migrations/0002_built_catalog.sql",
    "migrations/0003_weeek_deal_identity.sql", "migrations/0004_legacy_catalog_refs.sql"]) {
    const applied = spawnSync(node, [wrangler, "d1", "execute", "CRM_DB", "--config", config,
      "--local", "--persist-to", root, "--file", migration, "--yes", "--json"], { cwd, encoding: "utf8" });
    assert.equal(applied.status, 0, applied.stderr || applied.stdout);
  }
}
const draftFor = (buildId, companyId, title = "HTTP durable deal") => ({ buildId, companyId,
  exhibitionId: "demo-expo-001", title, companyInn: "0000000001",
  contactName: "Example Contact", dealComment: "Synthetic catalog request" });
async function schemas() {
  const ajv = new Ajv(); addFormats(ajv);
  for (const name of ["built-participants-input", "built-participants-output", "s03-built-timeline-input",
    "s03-built-note-input", "s03-built-reject-input", "s03-built-undo-input",
    "s04-review-input", "s04-create-input", "s04-operation-input",
    "prelead-event-response", "prelead-timeline-event", "prelead-timeline-response",
    "s04-review-output", "synthetic-deal-operation"]) {
    ajv.addSchema(JSON.parse(await readFile(new URL(`../schemas/${name}.schema.json`, import.meta.url))));
  }
  return (name, value) => { const valid = ajv.getSchema(`https://crm-web.example.invalid/schemas/${name}.schema.json`);
    assert.ok(valid(value), JSON.stringify(valid.errors)); };
}

test("opt-in public-shaped D1 HTTP routes and offline MCP share one durable S01/S03/S04 state", async () => {
  const root = mkdtempSync(join(tmpdir(), "crm-built-http-d1-"));
  let worker;
  try {
    migrate(root);
    worker = await start(root);
    const built = await request(worker.base, "POST", "/api/v1/catalog-builds", { exhibitionId: "demo-expo-001" },
      { key: "http-durable-build-a" });
    assert.equal(built.status, 201, JSON.stringify(built.body));
    const validate = await schemas();
    const buildId = built.body.buildId;
    validate("built-participants-input", { buildId, classification: "target" });
    const listPath = `/api/v1/catalog-builds/${buildId}/participants`;
    assert.equal((await request(worker.base, "GET", listPath, undefined, { disabled: true })).status, 404);
    const list = await request(worker.base, "GET", `${listPath}?classification=target`);
    assert.equal(list.status, 200);
    validate("built-participants-output", list.body);
    const company = list.body.items[0];
    assert.deepEqual((await request(worker.base, "GET", company.detailPath)).body.items, [company]);
    const browserPath = `/catalogs/${buildId}`;
    const browser = await fetch(`${worker.base}${browserPath}?classification=target`,
      { headers: { "x-test-profile": "demo-profile-a" } });
    const browserHtml = await browser.text();
    assert.equal(browser.status, 200);
    assert.match(browser.headers.get("content-type"), /text\/html/);
    assert.equal(browser.headers.get("cache-control"), "private, no-store");
    assert.match(browserHtml, new RegExp(`/catalogs/${buildId}/participants/${company.id}`));
    assert.match(browserHtml, new RegExp(company.name));
    assert.match(browserHtml, /Ревизия источника/);
    const cardBrowser = await fetch(`${worker.base}${browserPath}/participants/${company.id}`);
    const cardHtml = await cardBrowser.text();
    assert.equal(cardBrowser.status, 200);
    assert.match(cardHtml, new RegExp(company.name));
    assert.match(cardHtml, /ИНН/);
    assert.equal((await fetch(`${worker.base}${browserPath}/participants/${company.id}`,
      { headers: { "x-test-profile": "demo-profile-b" } })).status, 404);
    assert.equal((await fetch(`${worker.base}${browserPath}`,
      { headers: { "x-test-scopes": "" } })).status, 403);
    assert.equal((await fetch(`${worker.base}${browserPath}`, { headers: { "x-test-disable": "true" } })).status, 404);
    assert.equal((await fetch(`${worker.base}${browserPath}?q=a&q=b`)).status, 400);
    assert.equal((await fetch(`${worker.base}${browserPath}?classification=unknown`)).status, 200);
    assert.equal((await fetch(`${worker.base}${browserPath}?classification=invalid`)).status, 400);
    assert.equal((await fetch(`${worker.base}${browserPath}/participants/${company.id}?q=a`)).status, 400);
    assert.equal((await fetch(`${worker.base}${browserPath}?q=${"x".repeat(121)}`)).status, 400);
    const legacyEvent = "invented-expo-2026";
    const legacyEntries = [
      { id: "OLD001", n: "Invented Link Company", s: "A-01", t: 1, nt: 0,
        inn: "0000000001", ogrn: "0000000000001", ru: 1, rev: 250 },
      { id: "OLD002", n: "Invented Removed Company", s: "B-02", t: 0, nt: 1, ru: 1, rev: null }
    ];
    const firstLegacy = await request(worker.base, "POST", "/__import-legacy-fixture",
      { eventKey: legacyEvent, entries: legacyEntries });
    assert.equal(firstLegacy.status, 201, JSON.stringify(firstLegacy.body));
    const oldLink = `/api/v1/legacy-catalog-links/${legacyEvent}/OLD001`;
    const revisionQuery = `?sourceRevision=${firstLegacy.body.sourceRevision}`;
    const resolved = await request(worker.base, "GET", `${oldLink}${revisionQuery}`);
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.buildId, firstLegacy.body.buildId);
    assert.equal(resolved.body.sourceRevision, firstLegacy.body.sourceRevision);
    assert.equal(resolved.body.detailPath,
      `/api/v1/catalog-builds/${resolved.body.buildId}/participants/${resolved.body.companyId}`);
    assert.equal(resolved.body.browserPath,
      `/catalogs/${resolved.body.buildId}/participants/${resolved.body.companyId}`);
    const linkedCard = await fetch(`${worker.base}${resolved.body.browserPath}`);
    assert.equal(linkedCard.status, 200);
    assert.match(await linkedCard.text(), /Invented Link Company/);
    assert.equal((await request(worker.base, "GET", `${oldLink}${revisionQuery}`,
      undefined, { profile: "demo-profile-b" })).status, 404);
    assert.equal((await request(worker.base, "GET", `${oldLink}${revisionQuery}`,
      undefined, { scopes: [] })).status, 403);
    assert.equal((await request(worker.base, "GET", `${oldLink}${revisionQuery}`,
      undefined, { disabled: true })).status, 404);
    assert.equal((await request(worker.base, "GET", oldLink)).status, 400);
    assert.equal((await request(worker.base, "GET", `${oldLink}${revisionQuery}&sourceRevision=${firstLegacy.body.sourceRevision}`)).status, 400);
    assert.equal((await request(worker.base, "GET", `${oldLink}?sourceRevision=legacy-ex-sha256-${"0".repeat(64)}`)).status, 409);
    assert.equal((await request(worker.base, "GET", `/api/v1/legacy-catalog-links/${legacyEvent}/OLD%2F001${revisionQuery}`)).status, 400);
    assert.equal((await request(worker.base, "GET", `/api/v1/legacy-catalog-links/other-event/OLD001${revisionQuery}`)).status, 404);
    const duplicate = await request(worker.base, "POST", "/__import-legacy-fixture",
      { eventKey: legacyEvent, entries: [legacyEntries[0], { ...legacyEntries[1], id: "OLD001" }] });
    assert.equal(duplicate.status, 422);
    assert.equal(duplicate.body.status, "legacy_identity_conflict");
    const unsafe = await request(worker.base, "POST", "/__import-legacy-fixture",
      { eventKey: legacyEvent, entries: [{ ...legacyEntries[0], id: "OLD/001" }] });
    assert.equal(unsafe.status, 422);
    assert.equal(unsafe.body.status, "legacy_identity_conflict");
    const revised = await request(worker.base, "POST", "/__import-legacy-fixture",
      { eventKey: legacyEvent, entries: [{ ...legacyEntries[0], n: "Revised Link Company" }] });
    assert.equal(revised.status, 201);
    assert.notEqual(revised.body.sourceRevision, firstLegacy.body.sourceRevision);
    assert.equal((await request(worker.base, "GET", `${oldLink}${revisionQuery}`)).body.error,
      "legacy_link_revision_changed");
    const currentRevision = `?sourceRevision=${revised.body.sourceRevision}`;
    const current = await request(worker.base, "GET", `${oldLink}${currentRevision}`);
    assert.equal(current.status, 200);
    assert.equal(current.body.companyId, resolved.body.companyId);
    assert.equal(current.body.buildId, revised.body.buildId);
    assert.equal((await request(worker.base, "GET",
      `/api/v1/legacy-catalog-links/${legacyEvent}/OLD002${currentRevision}`)).status, 404);
    assert.match(await (await fetch(`${worker.base}${current.body.browserPath}`)).text(), /Revised Link Company/);
    const mcpList = await request(worker.base, "POST", "/__offline-mcp", { contract: "s01",
      arguments: { buildId, classification: "target" } });
    assert.deepEqual(mcpList.body.result.structuredContent, list.body);
    const tools = await request(worker.base, "POST", "/__offline-mcp", { method: "tools/list" });
    assert.deepEqual(tools.body.result.tools.map((item) => item.name).sort(), [
      "crm_built_catalog_participants_read", "crm_built_prelead_note_add", "crm_built_prelead_reject",
      "crm_built_prelead_rejection_undo", "crm_built_prelead_timeline_read",
      "crm_deal_create_from_participant", "crm_deal_get_operation", "crm_deal_prepare_from_participant",
      "crm_deal_reconcile_operation", "crm_deal_repair_catalog_link"
    ].sort());
    assert.equal((await request(worker.base, "POST", "/__offline-mcp", { contract: "s01",
      protocolVersion: "1900-01-01", arguments: { buildId } })).body.error.message, "CAPABILITY_VERSION_MISMATCH");
    assert.equal((await request(worker.base, "POST", "/__offline-mcp", { contract: "s01",
      capabilityVersion: "9.0.0", arguments: { buildId } })).body.error.message, "CAPABILITY_VERSION_MISMATCH");
    assert.equal((await request(worker.base, "GET", listPath, undefined, { profile: "demo-profile-b" })).status, 404);
    assert.equal((await request(worker.base, "GET", listPath, undefined, { scopes: [] })).status, 403);
    const builtB = await request(worker.base, "POST", "/api/v1/catalog-builds", { exhibitionId: "demo-expo-001" },
      { key: "http-durable-build-a", profile: "demo-profile-b" });
    assert.equal(builtB.status, 201);
    assert.notEqual(builtB.body.buildId, buildId);
    assert.equal((await request(worker.base, "GET", `/api/v1/catalog-builds/${builtB.body.buildId}/participants`,
      undefined, { profile: "demo-profile-b" })).status, 200);
    assert.equal((await request(worker.base, "GET", `/api/v1/catalog-builds/${builtB.body.buildId}/participants`)).status, 404);
    const binding = await request(worker.base, "POST", `${company.detailPath}/prelead`, {});
    assert.equal(binding.status, 201);
    const preleadId = binding.body.prelead.id;
    const noteOperationId = `op-${randomUUID()}`;
    validate("s03-built-note-input", { preleadId, operationId: noteOperationId, noteText: "HTTP synthetic interest" });
    const note = await request(worker.base, "POST", `/api/v1/preleads/${preleadId}/events`,
      { type: "note_added", operationId: noteOperationId, noteText: "HTTP synthetic interest" });
    assert.equal(note.status, 201, JSON.stringify(note.body));
    validate("prelead-event-response", note.body);
    assert.equal(note.body.prelead.companyId, company.id);
    assert.equal((await request(worker.base, "POST", `/api/v1/preleads/${preleadId}/events`,
      { type: "note_added", operationId: noteOperationId, noteText: "HTTP synthetic interest" })).status, 200);
    assert.equal((await request(worker.base, "POST", `/api/v1/preleads/${preleadId}/events`,
      { type: "note_added", operationId: noteOperationId, noteText: "Changed" })).status, 409);
    const rejectArgs = { type: "rejection_added", operationId: `op-${randomUUID()}`,
      reason: "Synthetic refusal" };
    const rejected = await request(worker.base, "POST", `/api/v1/preleads/${preleadId}/events`, rejectArgs);
    assert.equal(rejected.status, 201, JSON.stringify(rejected.body));
    validate("prelead-event-response", rejected.body);
    assert.equal(rejected.body.prelead.disposition, "rejected");
    assert.equal((await request(worker.base, "POST", `/api/v1/preleads/${preleadId}/events`, rejectArgs)).status, 200);
    assert.equal((await request(worker.base, "POST", `/api/v1/preleads/${preleadId}/events`,
      { ...rejectArgs, reason: "Changed" })).status, 409);
    assert.equal((await request(worker.base, "POST", `/api/v1/preleads/${preleadId}/events`,
      { type: "rejection_added", operationId: `op-${randomUUID()}`, reason: "Second rejection" })).status, 409);
    assert.equal((await request(worker.base, "POST", `/api/v1/preleads/${preleadId}/events`,
      rejectArgs, { profile: "demo-profile-b" })).status, 404);
    assert.equal((await request(worker.base, "POST", "/api/v1/deal-reviews",
      draftFor(buildId, company.id))).status, 404);
    const undoArgs = { preleadId, operationId: `op-${randomUUID()}`,
      targetEventId: rejected.body.event.eventId };
    validate("s03-built-undo-input", undoArgs);
    const undone = await request(worker.base, "POST", "/__offline-mcp", { contract: "s03",
      name: "crm_built_prelead_rejection_undo", arguments: undoArgs });
    assert.equal(undone.status, 200, JSON.stringify(undone.body));
    validate("prelead-event-response", undone.body.result.structuredContent);
    assert.equal(undone.body.result.structuredContent.prelead.disposition, "active");
    const undoReplay = await request(worker.base, "POST", "/__offline-mcp", { contract: "s03",
      name: "crm_built_prelead_rejection_undo", arguments: undoArgs });
    assert.equal(undoReplay.body.result.structuredContent.replayed, true);
    assert.equal((await request(worker.base, "POST", `/api/v1/preleads/${preleadId}/events`,
      { type: "rejection_undone", operationId: `op-${randomUUID()}`,
        targetEventId: rejected.body.event.eventId })).status, 409);
    await stop(worker.child);

    worker = await start(root);
    const recovered = await request(worker.base, "GET", `/api/v1/preleads/${preleadId}/timeline`);
    assert.equal(recovered.status, 200);
    const recoveredBuild = await request(worker.base, "GET", `/api/v1/catalog-builds/${buildId}`);
    assert.equal(recoveredBuild.status, 200);
    assert.equal(recoveredBuild.body.artifact.companies.length, built.body.artifact.companies.length);
    const replayBuild = await request(worker.base, "POST", "/api/v1/catalog-builds", { exhibitionId: "demo-expo-001" },
      { key: "http-durable-build-a" });
    assert.equal(replayBuild.status, 200);
    assert.equal(replayBuild.body.buildId, buildId);
    assert.equal(replayBuild.body.replayed, true);
    assert.equal((await request(worker.base, "POST", "/api/v1/catalog-builds", { exhibitionId: "demo-expo-002" },
      { key: "http-durable-build-a" })).status, 409);
    validate("prelead-timeline-response", recovered.body);
    assert.deepEqual(recovered.body.events.filter((event) => event.type === "note_added")
      .map((event) => event.payload.noteText), ["HTTP synthetic interest"]);
    const mcpTimeline = await request(worker.base, "POST", "/__offline-mcp", { contract: "s03",
      name: "crm_built_prelead_timeline_read", arguments: { preleadId } });
    validate("s03-built-timeline-input", { preleadId });
    assert.deepEqual(mcpTimeline.body.result.structuredContent, recovered.body);
    const secondNoteId = `op-${randomUUID()}`;
    const mcpNote = await request(worker.base, "POST", "/__offline-mcp", { contract: "s03",
      name: "crm_built_prelead_note_add", arguments: { preleadId, operationId: secondNoteId,
        noteText: "MCP synthetic context" } });
    validate("prelead-event-response", mcpNote.body.result.structuredContent);
    const afterMcpNote = await request(worker.base, "GET", `/api/v1/preleads/${preleadId}/timeline`);
    assert.deepEqual(afterMcpNote.body.events.at(-1), mcpNote.body.result.structuredContent.event);
    const rebuilt = await request(worker.base, "POST", "/api/v1/catalog-builds", { exhibitionId: "demo-expo-001" },
      { key: "http-durable-build-b" });
    assert.equal(rebuilt.status, 201);
    const rebound = await request(worker.base, "POST", `/api/v1/catalog-builds/${rebuilt.body.buildId}/participants/${company.id}/prelead`, {});
    assert.equal(rebound.body.prelead.id, preleadId);
    const draft = draftFor(rebuilt.body.buildId, company.id);
    validate("s04-review-input", draft);
    const httpReview = await request(worker.base, "POST", "/api/v1/deal-reviews", draft);
    assert.equal(httpReview.status, 201, JSON.stringify(httpReview.body));
    validate("s04-review-output", httpReview.body);
    assert.match(httpReview.body.details.dealComment, /HTTP synthetic interest/);
    assert.match(httpReview.body.details.dealComment, /MCP synthetic context/);
    const mcpReview = await request(worker.base, "POST", "/__offline-mcp", { contract: "s04",
      name: "crm_deal_prepare_from_participant", arguments: draft });
    assert.deepEqual(mcpReview.body.result.structuredContent.details, httpReview.body.details);
    const unapproved = await request(worker.base, "POST", `/api/v1/deal-reviews/${httpReview.body.reviewId}/confirm`,
      { revision: httpReview.body.revision });
    assert.equal(unapproved.status, 503);
    assert.equal(unapproved.body.error, "approval_authority_unavailable");
    await stop(worker.child);

    worker = await start(root);
    const readReview = await request(worker.base, "GET", `/api/v1/deal-reviews/${httpReview.body.reviewId}`);
    assert.deepEqual(readReview.body.details, httpReview.body.details);
    const confirmed = await request(worker.base, "POST", `/api/v1/deal-reviews/${httpReview.body.reviewId}/confirm`,
      { revision: httpReview.body.revision }, { approval: true });
    validate("s04-create-input", { reviewId: httpReview.body.reviewId, revision: httpReview.body.revision });
    assert.equal(confirmed.status, 201, JSON.stringify(confirmed.body));
    validate("synthetic-deal-operation", confirmed.body);
    assert.equal(confirmed.body.linkStatus, "linked");
    assert.equal((await request(worker.base, "GET", "/__provider-count")).body.calls, 1);
    const mcpOperation = await request(worker.base, "POST", "/__offline-mcp", { contract: "s04",
      name: "crm_deal_get_operation", arguments: { operationId: httpReview.body.operationId } });
    validate("s04-operation-input", { operationId: httpReview.body.operationId });
    assert.equal(mcpOperation.body.result.structuredContent.dealId, confirmed.body.dealId);
    const timeline = await request(worker.base, "GET", `/api/v1/preleads/${preleadId}/timeline`);
    validate("prelead-timeline-response", timeline.body);
    assert.deepEqual(timeline.body.events.map((event) => event.type),
      ["note_added", "rejection_added", "rejection_undone", "note_added", "deal_linked"]);
    assert.equal(timeline.body.prelead.disposition, "deal");
    await stop(worker.child);

    worker = await start(root);
    const replay = await request(worker.base, "POST", `/api/v1/deal-reviews/${httpReview.body.reviewId}/confirm`,
      { revision: httpReview.body.revision }, { approval: true });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.dealId, confirmed.body.dealId);
    assert.equal((await request(worker.base, "GET", "/__provider-count")).body.calls, 0);
    assert.equal((await request(worker.base, "GET", `/api/v1/preleads/${preleadId}/timeline`, undefined,
      { profile: "demo-profile-b" })).status, 404);
  } finally {
    if (worker) await stop(worker.child);
    rmSync(root, { recursive: true, force: true });
  }
});

test("the opt-in D1 HTTP and offline MCP modules have no Agent Run launch dependency", async () => {
  for (const name of ["built-catalog-d1-http.js", "built-d1-offline-mcp.js", "built-catalog-d1.js"]) {
    assert.doesNotMatch(await readFile(new URL(`../src/${name}`, import.meta.url), "utf8"),
      /runner\.launch|spawnAgentRun|agent-run/i);
  }
});

test("a rejection invalidates a prepared deal review until undo and a new review", async () => {
  const root = mkdtempSync(join(tmpdir(), "crm-built-disposition-stale-"));
  let worker;
  try {
    migrate(root); worker = await start(root);
    const built = await request(worker.base, "POST", "/api/v1/catalog-builds",
      { exhibitionId: "demo-expo-001" }, { key: "disposition-stale-build" });
    assert.equal(built.status, 201);
    const list = await request(worker.base, "GET",
      `/api/v1/catalog-builds/${built.body.buildId}/participants?classification=target`);
    const company = list.body.items[0];
    const bound = await request(worker.base, "POST", `${company.detailPath}/prelead`, {});
    const id = bound.body.prelead.id;
    const oldReview = await request(worker.base, "POST", "/api/v1/deal-reviews",
      draftFor(built.body.buildId, company.id));
    assert.equal(oldReview.status, 201);
    const rejected = await request(worker.base, "POST", `/api/v1/preleads/${id}/events`,
      { type: "rejection_added", operationId: `op-${randomUUID()}`, reason: "Synthetic mismatch" });
    assert.equal(rejected.status, 201);
    assert.equal((await request(worker.base, "POST", `/api/v1/deal-reviews/${oldReview.body.reviewId}/confirm`,
      { revision: oldReview.body.revision }, { approval: true })).status, 409);
    const undone = await request(worker.base, "POST", `/api/v1/preleads/${id}/events`,
      { type: "rejection_undone", operationId: `op-${randomUUID()}`,
        targetEventId: rejected.body.event.eventId });
    assert.equal(undone.status, 201);
    assert.equal((await request(worker.base, "POST", `/api/v1/deal-reviews/${oldReview.body.reviewId}/confirm`,
      { revision: oldReview.body.revision }, { approval: true })).status, 409);
    const freshReview = await request(worker.base, "POST", "/api/v1/deal-reviews",
      draftFor(built.body.buildId, company.id));
    assert.equal(freshReview.status, 201);
    const confirmed = await request(worker.base, "POST", `/api/v1/deal-reviews/${freshReview.body.reviewId}/confirm`,
      { revision: freshReview.body.revision }, { approval: true });
    assert.equal(confirmed.status, 201, JSON.stringify(confirmed.body));
    assert.equal((await request(worker.base, "GET", "/__provider-count")).body.calls, 1);
  } finally {
    if (worker) await stop(worker.child);
    rmSync(root, { recursive: true, force: true });
  }
});

test("public-shaped D1 unknown outcome remains unknown after restart without another POST", async () => {
  const root = mkdtempSync(join(tmpdir(), "crm-built-http-unknown-"));
  let worker;
  try {
    migrate(root); worker = await start(root);
    const built = await request(worker.base, "POST", "/api/v1/catalog-builds", { exhibitionId: "demo-expo-001" },
      { key: "http-unknown-build" });
    const list = await request(worker.base, "GET", `/api/v1/catalog-builds/${built.body.buildId}/participants?classification=target`);
    const companyId = list.body.items[0].id;
    const bound = await request(worker.base, "POST", `/api/v1/catalog-builds/${built.body.buildId}/participants/${companyId}/prelead`, {});
    const review = await request(worker.base, "POST", "/api/v1/deal-reviews",
      draftFor(built.body.buildId, companyId, "Unknown HTTP outcome"));
    assert.equal(review.status, 201);
    const path = `/api/v1/deal-reviews/${review.body.reviewId}/confirm`;
    const unknown = await request(worker.base, "POST", path, { revision: review.body.revision }, { approval: true });
    assert.equal(unknown.status, 202);
    assert.equal(unknown.body.status, "unknown");
    assert.equal((await request(worker.base, "GET", "/__provider-count")).body.calls, 1);
    const rejectedWhileUnknown = await request(worker.base, "POST",
      `/api/v1/preleads/${bound.body.prelead.id}/events`,
      { type: "rejection_added", operationId: `op-${randomUUID()}`, reason: "Unresolved provider outcome" });
    assert.equal(rejectedWhileUnknown.status, 409);
    assert.equal(rejectedWhileUnknown.body.error, "prelead_deal_conflict");
    await stop(worker.child);
    worker = await start(root);
    const replay = await request(worker.base, "POST", path, { revision: review.body.revision }, { approval: true });
    assert.equal(replay.status, 202);
    assert.equal(replay.body.status, "unknown");
    assert.equal((await request(worker.base, "GET", "/__provider-count")).body.calls, 0);
  } finally {
    if (worker) await stop(worker.child);
    rmSync(root, { recursive: true, force: true });
  }
});
