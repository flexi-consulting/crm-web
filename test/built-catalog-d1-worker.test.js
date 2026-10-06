import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { captureLegacyCatalogs, restoreLegacyCatalogsLocal } from "../src/private-legacy-handoff.js";

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
  const inspectorPort = await freePort();
  const child = spawn(node, [wrangler, "dev", "--config", config, "--ip", "127.0.0.1",
    "--port", String(port), "--inspector-port", String(inspectorPort),
    "--persist-to", root, "--log-level", "error"],
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

const sha256 = value => createHash("sha256").update(value).digest("hex");

test("reviewed legacy projection persists through local D1 Worker with exact refs and replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "crm-reviewed-import-d1-"));
  let worker;
  const eventKey = "invented-reviewed-expo";
  const entries = [
    { id: "SYN001", n: "Invented Approved Company", s: "B-01", t: 1, nt: 0,
      inn: "0000000001", ogrn: "0000000000001", ru: 1, rev: 100, href: "https://example.invalid/one" },
    { id: "SYN002", n: "Invented Excluded Company", s: "B-02", t: 0, nt: 1,
      ru: 1, rev: null, href: "https://example.invalid/two" },
  ];
  const manifestSha256 = "a".repeat(64), sourceSha256 = "b".repeat(64);
  const sourcePath = "legacy-owner/catalog.html", legacyUserId = "legacy-owner";
  const profileBinding = { status: "confirmed", issuer: "control-plane", legacyUserId,
    principalId: "synthetic-principal", profileId: "demo-profile-a", evidenceSha256: "c".repeat(64) };
  const packet = { version: 1, status: "private_review_required", approvedForImport: false, manifestSha256,
    owners: [{ legacyUserId, proposedPrincipalId: null, proposedProfileId: null, reviewerDecision: "pending",
      catalogs: [{ sourcePath, sourceSha256, eventKey }] }] };
  const decisions = { version: 1, status: "reviewed", packetSha256: sha256(JSON.stringify(packet)),
    manifestSha256, sourcePath, sourceSha256, eventKey, legacyUserId, profileId: profileBinding.profileId,
    principalId: profileBinding.principalId, profileBindingEvidenceSha256: profileBinding.evidenceSha256,
    reviewerEvidenceSha256: "d".repeat(64), rows: entries.map((row, index) => ({ index,
      rowSha256: sha256(JSON.stringify(row)), outcome: index === 0 ? "include" : "exclude",
      ...(index === 0 ? { replacement: row } : { reason: "synthetic duplicate excluded by reviewer" }),
      evidenceSha256: "e".repeat(64) })) };
  const request = { packet, manifestSha256, sourceSha256, sourcePath, eventKey, profileBinding, entries, decisions };
  try {
    for (const migration of ["migrations/0001_s04_domain.sql", "migrations/0002_built_catalog.sql",
      "migrations/0003_weeek_deal_identity.sql", "migrations/0004_legacy_catalog_refs.sql"]) {
      const applied = spawnSync(node, [wrangler, "d1", "execute", "CRM_DB", "--config", config,
        "--local", "--persist-to", root, "--file", migration, "--yes", "--json"], { cwd, encoding: "utf8" });
      assert.equal(applied.status, 0, applied.stderr || applied.stdout);
    }
    worker = await startWorker(root);
    const rejected = await call(worker.base, "/catalog/import-reviewed-legacy", {
      ...request, decisions: { ...decisions, sourceSha256: "f".repeat(64) } });
    assert.equal(rejected.status, 422);
    assert.equal(rejected.body.status, "review_decisions_unverified");
    const imported = await call(worker.base, "/catalog/import-reviewed-legacy", request);
    assert.equal(imported.status, 201, JSON.stringify(imported.body));
    assert.equal(imported.body.imported, 1);
    assert.equal(imported.body.excluded, 1);
    const replay = await call(worker.base, "/catalog/import-reviewed-legacy", request);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.buildId, imported.body.buildId);
    const ref = await call(worker.base, "/catalog/resolve-legacy", { eventKey, legacyId: "SYN001" });
    assert.equal(ref.status, 200);
    assert.equal(ref.body.buildId, imported.body.buildId);
    assert.equal((await call(worker.base, "/catalog/resolve-legacy", { eventKey, legacyId: "SYN002" })).status, 404);
    assert.equal((await call(worker.base, "/catalog/resolve-legacy", { eventKey, legacyId: "SYN001" },
      { profile: "demo-profile-b" })).status, 404);
  } finally {
    if (worker) await stopWorker(worker.child);
    rmSync(root, { recursive: true, force: true });
  }
});

test("D1 built catalog, stable prelead/note and reviewed deal survive three Worker instances", async () => {
  const root = mkdtempSync(join(tmpdir(), "crm-built-catalog-d1-"));
  let worker;
  try {
    for (const migration of ["migrations/0001_s04_domain.sql", "migrations/0002_built_catalog.sql",
      "migrations/0003_weeek_deal_identity.sql", "migrations/0004_legacy_catalog_refs.sql"]) {
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
    const permuted = await call(worker.base, "/catalog/build", { exhibitionId: "demo-expo-001",
      idempotencyKey: "durable-permuted", reverseArtifact: true });
    assert.equal(permuted.status, 201);
    const permutedRead = await call(worker.base, "/catalog/read", { buildId: permuted.body.buildId });
    assert.equal(permutedRead.status, 200);
    assert.equal(permutedRead.body.items.length, 4);
    assert.equal((await call(worker.base, "/catalog/read", { buildId: permuted.body.buildId, q: 42 })).status, 400);
    assert.equal((await call(worker.base, "/catalog/read", { buildId: permuted.body.buildId, classification: "unsafe" })).status, 400);
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

test("private byte receipt and explicit mapping restore one invented EX catalog to local D1", async () => {
  const root = mkdtempSync(join(tmpdir(), "crm-private-d1-"));
  let worker;
  try {
    const sourceRoot = join(root, "source-users");
    const data = join(sourceRoot, "invented-source-profile", "projects", "invented-project", "data");
    const deployed = join(sourceRoot, "invented-source-profile", "projects", "invented-project",
      "deploy", "demo-expo-001");
    mkdirSync(data, { recursive: true }); mkdirSync(deployed, { recursive: true });
    const entries = [{ id: "EX001", n: "Invented Local D1 Participant", s: "B-01",
      t: 1, nt: 0, inn: "0000000001", ogrn: "0000000000001", ru: 1, rev: 200, ry: 2025,
      prof: -1.5, py: 2024, cat: "Invented synthetic category", b: "<em>Invented description</em>",
      seg: "Synthetic segment", phone: "synthetic-contact-do-not-import" }];
    writeFileSync(join(deployed, "index.html"),
      `<script>const EX = ${JSON.stringify(entries)};const EVENT_KEY = 'demo-expo-001';</script>`);
    writeFileSync(join(data, "enriched.json"), JSON.stringify([{ n: "Invented input" }]));
    const backup = join(root, "private-backup");
    assert.equal((await captureLegacyCatalogs({ sourceRoot, outputDir: backup })).files, 2);
    const manifest = JSON.parse(readFileSync(join(backup, "manifest.json"), "utf8"));
    const catalog = manifest.records.find((item) => item.kind === "deployed_html");
    const mappingFile = join(root, "private-mapping.json");
    writeFileSync(mappingFile, JSON.stringify({ version: 1, catalogs: [{
      sourcePath: catalog.sourcePath, sourceSha256: catalog.objectSha256,
      profileRef: "demo-profile-a", eventKey: "demo-expo-001", resolutions: {},
      artifactVersions: ["1.0.0", "1.1.0"]
    }] }));
    const db = join(root, "d1");
    for (const migration of ["migrations/0001_s04_domain.sql", "migrations/0002_built_catalog.sql",
      "migrations/0003_weeek_deal_identity.sql", "migrations/0004_legacy_catalog_refs.sql",
      "migrations/0010_catalog_v11_artifacts.sql"]) {
      const applied = spawnSync(node, [wrangler, "d1", "execute", "CRM_DB", "--config", config,
        "--local", "--persist-to", db, "--file", migration, "--yes", "--json"], { cwd, encoding: "utf8" });
      assert.equal(applied.status, 0, applied.stderr || applied.stdout);
    }
    worker = await startWorker(db);
    const receipts = await restoreLegacyCatalogsLocal({ backupDir: backup,
      mappingFile, endpoint: `${worker.base}/` });
    assert.equal(receipts.length, 2);
    assert.equal(receipts.find(receipt => receipt.version === "1.0.0").status, "stored");
    assert.equal(receipts.find(receipt => receipt.version === "1.1.0").status, "stored");
    const replay = await restoreLegacyCatalogsLocal({ backupDir: backup,
      mappingFile, endpoint: `${worker.base}/` });
    assert.ok(replay.every(receipt => receipt.status === "replay"));
    const linked = await call(worker.base, "/catalog/resolve-legacy",
      { eventKey: "demo-expo-001", legacyId: "EX001" });
    assert.equal(linked.status, 200);
    assert.equal(linked.body.buildId, receipts.find(receipt => receipt.version === "1.0.0").buildId);
    const listResponse = await fetch(`${worker.base}/api/v1/catalogs/demo-expo-001/entries?query=synthetic%20category`);
    assert.equal(listResponse.status, 200);
    const list = await listResponse.json();
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].category, "Invented synthetic category");
    assert.equal(list.items[0].revenueRub, 200_000_000);
    assert.equal(list.items[0].revenueYear, 2025);
    assert.equal(list.items[0].profitRub, -1_500_000);
    assert.equal(list.items[0].profitYear, 2024);
    assert.equal(JSON.stringify(list).includes("synthetic-contact-do-not-import"), false);
    const page = await fetch(`${worker.base}/catalogs/demo-expo-001?profitBand=loss`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /&lt;em&gt;Invented description&lt;\/em&gt;/);
  } finally {
    if (worker) await stopWorker(worker.child);
    rmSync(root, { recursive: true, force: true });
  }
});

test("invented legacy EX snapshot keeps event/id links through D1 rebuild, note and reviewed deal", async () => {
  const root = mkdtempSync(join(tmpdir(), "crm-legacy-ex-d1-"));
  let worker;
  const entries = [
    { id: "LNG001", n: "Invented Loom Works", s: "A-01", t: 1, nt: 0,
      inn: "0000000001", ogrn: "0000000000001", ru: 1, rev: 250,
      href: "https://example.invalid/catalog/loom", w: "https://example.invalid/loom" },
    { id: "21_dot_12", n: "Invented Supplier", s: "A-02", t: 0, nt: 1, ru: 1,
      rev: null, href: "https://example.invalid/catalog/supplier" }
  ];
  const eventKey = "demo-expo-001";
  const link = { eventKey, legacyId: "LNG001" };
  try {
    for (const migration of ["migrations/0001_s04_domain.sql", "migrations/0002_built_catalog.sql",
      "migrations/0003_weeek_deal_identity.sql", "migrations/0004_legacy_catalog_refs.sql"]) {
      const applied = spawnSync(node, [wrangler, "d1", "execute", "CRM_DB", "--config", config,
        "--local", "--persist-to", root, "--file", migration, "--yes", "--json"], { cwd, encoding: "utf8" });
      assert.equal(applied.status, 0, applied.stderr || applied.stdout);
    }
    worker = await startWorker(root);
    const imported = await call(worker.base, "/catalog/import-legacy", { eventKey, entries });
    assert.equal(imported.status, 201, JSON.stringify(imported.body));
    assert.equal(imported.body.imported, 2);
    assert.match(imported.body.sourceRevision, /^legacy-ex-sha256-[0-9a-f]{64}$/);
    assert.equal((await call(worker.base, "/catalog/import-legacy", { eventKey, entries })).status, 200);
    const blocked = await call(worker.base, "/catalog/import-legacy", { eventKey,
      entries: [{ ...entries[0], id: "LNG001" }, { ...entries[1], id: "LNG001" }] });
    assert.equal(blocked.status, 422);
    assert.equal(blocked.body.status, "legacy_identity_conflict");
    assert.equal((await call(worker.base, "/catalog/import-legacy", { eventKey,
      entries: [{ ...entries[0], id: "13C18/13D19" }] })).body.status, "legacy_identity_conflict");
    const resolved = await call(worker.base, "/catalog/resolve-legacy", link);
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.buildId, imported.body.buildId);
    assert.match(resolved.body.companyId, /^co-[a-f0-9]{20}$/);
    assert.equal((await call(worker.base, "/catalog/resolve-legacy", link,
      { profile: "demo-profile-b" })).status, 404);
    const card = await call(worker.base, "/catalog/read", { buildId: resolved.body.buildId,
      companyId: resolved.body.companyId });
    assert.equal(card.status, 200);
    assert.equal(card.body.items[0].name, entries[0].n);
    assert.equal(card.body.items[0].enrichment.revenueRub, 250_000_000);
    assert.equal(card.body.items[0].registry.status, "unknown");
    assert.equal(card.body.items[0].qualification.reason, "legacy_classification_unverified");
    const binding = await call(worker.base, "/catalog/bind", { buildId: resolved.body.buildId,
      companyId: resolved.body.companyId });
    assert.equal(binding.status, 201);
    const noted = await call(worker.base, "/prelead/note", { preleadId: binding.body.prelead.id,
      operationId: `op-${randomUUID()}`, noteText: "Invented interest" });
    assert.equal(noted.status, 201);
    await stopWorker(worker.child);
    worker = await startWorker(root);
    assert.equal((await call(worker.base, "/catalog/resolve-legacy", link)).body.companyId,
      resolved.body.companyId);
    const revisedEntries = [{ ...entries[0], n: "Invented Loom Works Updated" }, entries[1]];
    const rebuilt = await call(worker.base, "/catalog/import-legacy", { eventKey, entries: revisedEntries });
    assert.equal(rebuilt.status, 201);
    assert.notEqual(rebuilt.body.buildId, imported.body.buildId);
    const latest = await call(worker.base, "/catalog/resolve-legacy", link);
    assert.equal(latest.body.companyId, resolved.body.companyId);
    assert.equal(latest.body.buildId, rebuilt.body.buildId);
    const rebound = await call(worker.base, "/catalog/bind", { buildId: rebuilt.body.buildId,
      companyId: latest.body.companyId });
    assert.equal(rebound.status, 201);
    assert.equal(rebound.body.prelead.id, binding.body.prelead.id);
    const draft = { buildId: rebuilt.body.buildId, companyId: latest.body.companyId,
      exhibitionId: eventKey, title: "Invented catalog deal", companyInn: entries[0].inn,
      contactName: "Invented Contact", dealComment: "Synthetic review" };
    const review = await call(worker.base, "/review/prepare", draft);
    assert.equal(review.status, 201, JSON.stringify(review.body));
    assert.match(review.body.details.dealComment, /Invented interest/);
    const deal = await call(worker.base, "/review/confirm",
      { reviewId: review.body.reviewId, revision: review.body.revision }, { approval: true });
    assert.equal(deal.status, 201, JSON.stringify(deal.body));
    assert.equal(deal.body.linkStatus, "linked");
    assert.equal((await call(worker.base, "/provider/count", {})).body.calls, 1);
    const reduced = await call(worker.base, "/catalog/import-legacy", { eventKey,
      entries: [revisedEntries[0]] });
    assert.equal(reduced.status, 201);
    assert.equal((await call(worker.base, "/catalog/resolve-legacy",
      { eventKey, legacyId: "21_dot_12" })).status, 404);
    assert.equal((await call(worker.base, "/catalog/resolve-legacy", link)).body.companyId,
      resolved.body.companyId);
  } finally {
    if (worker) await stopWorker(worker.child);
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown built-participant provider outcome is reserved and never retried after restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "crm-built-unknown-d1-"));
  let worker;
  try {
    for (const migration of ["migrations/0001_s04_domain.sql", "migrations/0002_built_catalog.sql",
      "migrations/0003_weeek_deal_identity.sql", "migrations/0004_legacy_catalog_refs.sql"]) {
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
