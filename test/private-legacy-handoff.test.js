import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { projectLegacyExSnapshot } from "../src/legacy-ex-snapshot.js";
import { captureLegacyCatalogs, verifyLegacyCatalogBackup, prepareLegacyRestore,
  restoreLegacyCatalogsLocal, parseLegacyExHtml } from "../src/private-legacy-handoff.js";
import { importReviewedLegacyExSnapshot } from "../src/legacy-import-approval.js";

const invented = [
  { id: "LNG001", n: "Invented Loom", s: "A-01", t: 1, nt: 0,
    inn: "0000000001", ogrn: "0000000000001", ru: 1, rev: 250 },
  { id: "LNG001", n: "Invented Loom Two", s: "A-02", t: 0, nt: 1, ru: 1 },
  { id: "13С11", n: "Invented Cyrillic ID", s: "A-03", t: 0, nt: 0, ru: 1 }
];
const html = (rows) => `<html><script>const EX = ${JSON.stringify(rows)};\nconst EVENT_KEY = 'invented-expo-2026';</script></html>`;
const hash = (value) => createHash("sha256").update(value).digest("hex");

test("private capture copies exact HTML and source JSON bytes and quarantines all ID conflicts", async () => {
  const root = await mkdtemp(join(tmpdir(), "crm-private-handoff-"));
  try {
    const sourceRoot = join(root, "users");
    const project = join(sourceRoot, "invented-profile", "projects", "invented-project");
    const data = join(project, "data"), deployed = join(project, "deploy", "invented-expo-2026");
    await mkdir(data, { recursive: true }); await mkdir(deployed, { recursive: true });
    const rawHtml = Buffer.from(html(invented), "utf8");
    await writeFile(join(deployed, "index.html"), rawHtml);
    await writeFile(join(data, "enriched.json"), JSON.stringify([{ n: "Invented source" }]));
    const backup = join(root, "backup");
    const captured = await captureLegacyCatalogs({ sourceRoot, outputDir: backup });
    assert.deepEqual({ ...captured, manifestSha256: undefined },
      { files: 2, html: 1, sourceJson: 1, duplicateIds: 1, unsafeIds: 1,
        manifestSha256: undefined });
    assert.match(captured.manifestSha256, /^[a-f0-9]{64}$/);
    assert.equal((await stat(backup)).mode & 0o777, 0o700);
    const manifest = await verifyLegacyCatalogBackup(backup);
    assert.equal(manifest.manifestSha256, captured.manifestSha256);
    const catalog = manifest.records.find((item) => item.kind === "deployed_html");
    assert.deepEqual(await readFile(join(backup, "objects", catalog.objectSha256)), rawHtml);
    assert.equal((await stat(join(backup, "objects", catalog.objectSha256))).mode & 0o777, 0o600);
    const report = JSON.parse(await readFile(join(backup, "identity-quarantine.json"), "utf8"));
    assert.deepEqual(report.catalogs[0].duplicates, [{ id: "LNG001", indices: [0, 1] }]);
    assert.equal(report.catalogs[0].unsafe[0].id, "13С11");
    const parsed = parseLegacyExHtml(rawHtml);
    const manifestSha256 = manifest.manifestSha256;
    const profileBinding = { status: "confirmed", issuer: "control-plane", legacyUserId: "invented-profile",
      principalId: "synthetic-principal", profileId: "demo-profile-a", evidenceSha256: "c".repeat(64) };
    const packet = { version: 1, status: "private_review_required", approvedForImport: false, manifestSha256,
      owners: [{ legacyUserId: "invented-profile", catalogs: [{ sourcePath: catalog.sourcePath,
        sourceSha256: catalog.objectSha256, eventKey: "invented-expo-2026" }] }] };
    const decisions = { version: 1, status: "reviewed", packetSha256: hash(JSON.stringify(packet)),
      manifestSha256, sourcePath: catalog.sourcePath, sourceSha256: catalog.objectSha256,
      eventKey: "invented-expo-2026", legacyUserId: "invented-profile", profileId: "demo-profile-a",
      principalId: "synthetic-principal", profileBindingEvidenceSha256: profileBinding.evidenceSha256,
      reviewerEvidenceSha256: "d".repeat(64), rows: parsed.entries.map((row, index) => ({ index,
        rowSha256: hash(JSON.stringify(row)), outcome: "include", replacement: { ...row,
          id: index === 0 ? "LNG001" : index === 1 ? "LNG002" : "CYR011" }, evidenceSha256: "e".repeat(64) })) };
    const reviewBundleFile = join(root, "private-review-bundle.json");
    await writeFile(reviewBundleFile, JSON.stringify({ version: 1, manifestSha256, packet,
      catalogs: [{ sourcePath: catalog.sourcePath, sourceSha256: catalog.objectSha256,
        profileBinding, decisions }] }));
    let calls = 0;
    const fakeFetch = async (_url, options) => {
      calls++;
      assert.equal(new URL(_url).pathname, "/catalog/import-reviewed-legacy");
      const input = JSON.parse(options.body);
      const { sourceBytesBase64, ...review } = input;
      const saved = await importReviewedLegacyExSnapshot({ repository: { async saveBuild(build) {
        return { status: "stored", buildId: build.build.buildId };
      } }, ...review, sourceBytes: Buffer.from(sourceBytesBase64, "base64") });
      return new Response(JSON.stringify(saved), { status: saved.status === "stored" ? 201 : 422 });
    };
    const receipts = await restoreLegacyCatalogsLocal({ backupDir: backup,
      reviewBundleFile, endpoint: "http://127.0.0.1:8787/", fetchImpl: fakeFetch });
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].status, "stored");
    assert.equal(calls, 1);
    await assert.rejects(restoreLegacyCatalogsLocal({ backupDir: backup,
      reviewBundleFile, endpoint: "https://public.example.invalid/", fetchImpl: fakeFetch }),
    /local_d1_endpoint_required/);
    assert.equal(calls, 1);
    const object = join(backup, "objects", catalog.objectSha256);
    const reportFile = join(backup, "identity-quarantine.json");
    const originalReport = await readFile(reportFile);
    await writeFile(reportFile, Buffer.concat([originalReport, Buffer.from(" ")]));
    await assert.rejects(verifyLegacyCatalogBackup(backup), /legacy_backup_byte_mismatch/);
    await writeFile(reportFile, originalReport);
    await writeFile(object, Buffer.concat([rawHtml, Buffer.from("tamper")]));
    await assert.rejects(verifyLegacyCatalogBackup(backup), /legacy_backup_byte_mismatch/);
    await mkdir(join(root, ".git"));
    await assert.rejects(captureLegacyCatalogs({ sourceRoot,
      outputDir: join(root, "accidental-public-backup") }), /legacy_private_output_in_git_worktree/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("current legacy source shape imports only supported facts and preserves missing classification as unknown", async () => {
  const bytes = await readFile(new URL("./fixtures/legacy-ex-current-shape.synthetic.html", import.meta.url));
  const parsed = parseLegacyExHtml(bytes);
  assert.equal(parsed.eventKey, "synthetic-current-source-shape");
  assert.deepEqual(Object.keys(parsed.entries[0]), ["id", "n", "s", "c", "b", "w", "p", "e", "ru", "t",
    "cats", "dir", "dirpos", "rev", "ry", "prof", "py"]);
  const projected = projectLegacyExSnapshot({ profileRef: "demo-profile-a", ...parsed });
  assert.equal(projected.status, "projected");
  const byName = Object.fromEntries(projected.build.artifact.companies.map((company) => [company.name, company]));
  assert.equal(byName["Synthetic Exhibitor 001"].qualification.classification, "target");
  assert.equal(byName["Synthetic Exhibitor 001"].source.category, "Synthetic category");
  assert.equal(byName["Synthetic Exhibitor 001"].source.description, "Synthetic product summary");
  assert.equal(byName["Synthetic Exhibitor 001"].enrichment.profitRub, 10_000_000);
  assert.equal(byName["Synthetic Exhibitor 002"].qualification.classification, "unknown");
  assert.equal(projected.build.report.validation.counts.unknowns, 1);
  const serialized = JSON.stringify(projected.build.artifact);
  for (const sourceOnly of ["+7 000 000-00-01", "contact001@example.invalid", "Synthetic Director 001",
    "Synthetic role", "Sample City"])
    assert.equal(serialized.includes(sourceOnly), false, `source-only field leaked: ${sourceOnly}`);
});

test("preflights every catalog decision before the first local D1 write", async () => {
  const root = await mkdtemp(join(tmpdir(), "crm-private-preflight-"));
  try {
    const sourceRoot = join(root, "users"), backup = join(root, "backup");
    const sourceRows = [
      { eventKey: "invented-first", row: { id: "FIRST001", n: "First Invented", s: "A-1", t: 0, nt: 0, ru: 1 } },
      { eventKey: "invented-second", row: { id: "SECOND01", n: "Second Invented", s: "A-2", t: 0, nt: 0, ru: 1 } }
    ];
    for (const item of sourceRows) {
      const dir = join(sourceRoot, "invented-owner", "projects", "invented-project", "deploy", item.eventKey);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "index.html"), html([item.row]).replace("invented-expo-2026", item.eventKey));
    }
    await captureLegacyCatalogs({ sourceRoot, outputDir: backup });
    const manifest = await verifyLegacyCatalogBackup(backup);
    const records = manifest.records.filter((record) => record.kind === "deployed_html");
    const profileBinding = { status: "confirmed", issuer: "control-plane", legacyUserId: "invented-owner",
      principalId: "synthetic-principal", profileId: "demo-profile-a", evidenceSha256: "c".repeat(64) };
    const packet = { version: 1, status: "private_review_required", approvedForImport: false,
      manifestSha256: manifest.manifestSha256, owners: [{ legacyUserId: "invented-owner",
        catalogs: records.map(record => ({ sourcePath: record.sourcePath, sourceSha256: record.objectSha256,
          eventKey: record.eventKey })) }] };
    const catalogs = [];
    for (const [index, record] of records.entries()) {
      const bytes = await readFile(join(backup, "objects", record.objectSha256));
      const parsed = parseLegacyExHtml(bytes);
      const decisions = { version: 1, status: "reviewed", packetSha256: hash(JSON.stringify(packet)),
        manifestSha256: manifest.manifestSha256, sourcePath: record.sourcePath,
        sourceSha256: record.objectSha256, eventKey: record.eventKey,
        legacyUserId: "invented-owner", profileId: profileBinding.profileId,
        principalId: profileBinding.principalId, profileBindingEvidenceSha256: profileBinding.evidenceSha256,
        reviewerEvidenceSha256: "d".repeat(64), rows: index === 1 ? [] : parsed.entries.map((row, rowIndex) => ({
          index: rowIndex, rowSha256: hash(JSON.stringify(row)), outcome: "include",
          replacement: row, evidenceSha256: "e".repeat(64) })) };
      catalogs.push({ sourcePath: record.sourcePath, sourceSha256: record.objectSha256, profileBinding, decisions });
    }
    const reviewBundleFile = join(root, "private-review-bundle.json");
    await writeFile(reviewBundleFile, JSON.stringify({ version: 1, manifestSha256: manifest.manifestSha256,
      packet, catalogs }));
    let calls = 0;
    await assert.rejects(restoreLegacyCatalogsLocal({ backupDir: backup, reviewBundleFile,
      endpoint: "http://127.0.0.1:8787/", fetchImpl: async () => { calls++; } }),
    /legacy_review_row_decision_coverage_invalid/);
    assert.equal(calls, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
