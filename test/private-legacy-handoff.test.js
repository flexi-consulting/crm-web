import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectLegacyExSnapshot, projectLegacyExSnapshotV11 } from "../src/legacy-ex-snapshot.js";
import { captureLegacyCatalogs, verifyLegacyCatalogBackup, prepareLegacyRestore,
  restoreLegacyCatalogsLocal } from "../src/private-legacy-handoff.js";

const invented = [
  { id: "LNG001", n: "Invented Loom", s: "A-01", t: 1, nt: 0,
    inn: "0000000001", ogrn: "0000000000001", ru: 1, rev: 250 },
  { id: "LNG001", n: "Invented Loom Two", s: "A-02", t: 0, nt: 1, ru: 1 },
  { id: "13С11", n: "Invented Cyrillic ID", s: "A-03", t: 0, nt: 0, ru: 1 }
];
const html = (rows) => `<html><script>const EX = ${JSON.stringify(rows)};\nconst EVENT_KEY = 'invented-expo-2026';</script></html>`;

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
    const mappingFile = join(root, "private-mapping.json");
    const base = { version: 1, catalogs: [{ sourcePath: catalog.sourcePath,
      sourceSha256: catalog.objectSha256, profileRef: "demo-profile-a",
      eventKey: "invented-expo-2026", resolutions: {} }] };
    await writeFile(mappingFile, JSON.stringify(base));
    let calls = 0;
    const fakeFetch = async (target, options) => {
      calls++;
      const input = JSON.parse(options.body);
      if (new URL(target).pathname === "/catalog/import-legacy-v11") {
        const projected = projectLegacyExSnapshotV11({ profileRef: options.headers["x-test-profile"],
          eventKey: input.eventKey, entries: input.entries });
        return new Response(JSON.stringify({ status: "stored", exhibitionId: input.eventKey,
          sourceRevision: projected.artifact.sourceRevision }), { status: 201 });
      }
      const projected = projectLegacyExSnapshot({ profileRef: options.headers["x-test-profile"],
        eventKey: input.eventKey, entries: input.entries });
      return new Response(JSON.stringify({ status: "stored", buildId: projected.build.buildId,
        sourceRevision: projected.build.artifact.sourceRevision }), { status: 201 });
    };
    await assert.rejects(restoreLegacyCatalogsLocal({ backupDir: backup,
      mappingFile, endpoint: "http://127.0.0.1:8787/", fetchImpl: fakeFetch }),
    /legacy_identity_resolution_required/);
    assert.equal(calls, 0);
    base.catalogs[0].resolutions = { "0": "LNG001", "1": "LNG002", "2": "CYR011" };
    base.catalogs[0].artifactVersions = ["1.0.0", "1.1.0"];
    await writeFile(mappingFile, JSON.stringify(base));
    const ready = await prepareLegacyRestore({ backupDir: backup, mappingFile });
    assert.deepEqual(ready[0].entries.map((item) => item.id), ["LNG001", "LNG002", "CYR011"]);
    assert.deepEqual(ready[0].artifacts.map((item) => item.version), ["1.0.0", "1.1.0"]);
    const receipts = await restoreLegacyCatalogsLocal({ backupDir: backup,
      mappingFile, endpoint: "http://127.0.0.1:8787/", fetchImpl: fakeFetch });
    assert.deepEqual(receipts.map(item => item.version), ["1.0.0", "1.1.0"]);
    assert.equal(calls, 2);
    await assert.rejects(restoreLegacyCatalogsLocal({ backupDir: backup,
      mappingFile, endpoint: "https://public.example.invalid/", fetchImpl: fakeFetch }),
    /local_d1_endpoint_required/);
    assert.equal(calls, 2);
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
