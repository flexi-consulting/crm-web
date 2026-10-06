import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildLegacyProfileReviewPacket } from "../src/legacy-profile-review-packet.js";
import { buildLegacyImportDecisionPacket } from "../src/legacy-import-decision-packet.js";
import { captureLegacyCatalogs, verifyLegacyCatalogBackup } from "../src/private-legacy-handoff.js";

const row = (id, name) => ({ id, n: name, s: "A-1", t: 0, nt: 0, ru: 1 });
const html = (event, rows) => `<script>const EVENT_KEY = '${event}'; const EX = ${JSON.stringify(rows)};</script>`;

test("private decision queue verifies bytes, exposes every ambiguous row, and grants no import", async () => {
  const root = await mkdtemp(join(tmpdir(), "crm-import-review-"));
  try {
    const source = join(root, "source");
    for (const [event, rows] of [
      ["invented-conflict", [row("DUP", "A"), row("DUP", "B"), row("кириллица", "C")]],
      ["invented-clean", [row("CLEAN", "D")]],
      ["invented-link", [{ ...row("LINK", "E"), href: "relative/link" }]]
    ]) {
      const path = join(source, "old-owner", "projects", event, "deploy", event);
      await mkdir(path, { recursive: true });
      await writeFile(join(path, "index.html"), html(event, rows));
    }
    const backup = join(root, "backup");
    await captureLegacyCatalogs({ sourceRoot: source, outputDir: backup });
    const manifest = await verifyLegacyCatalogBackup(backup);
    const reviewPath = join(root, "profile-review.json");
    const review = buildLegacyProfileReviewPacket(manifest, manifest.manifestSha256);
    await writeFile(reviewPath, JSON.stringify(review));
    const packet = await buildLegacyImportDecisionPacket({ backupDir: backup,
      reviewPacketPath: reviewPath });
    assert.equal(packet.approvedForImport, false);
    assert.equal(packet.owners[0].proposedProfileId, null);
    assert.equal(packet.owners[0].catalogs.length, 3);
    const conflict = packet.owners[0].catalogs.find((item) => item.eventKey === "invented-conflict");
    assert.equal(conflict.structuralProjectionStatus, "blocked_on_identity_resolution");
    assert.deepEqual(conflict.identityDecisions.map((item) => item.index), [0, 1, 2]);
    assert.deepEqual(conflict.identityDecisions[0].issues, ["duplicate_id"]);
    assert.deepEqual(conflict.identityDecisions[2].issues, ["unsafe_id"]);
    assert.match(conflict.identityDecisions[0].rowSha256, /^[a-f0-9]{64}$/);
    assert.equal(conflict.identityDecisions[0].replacementId, null);
    assert.equal(packet.owners[0].catalogs.find((item) => item.eventKey === "invented-clean")
      .structuralProjectionStatus, "projected");
    const link = packet.owners[0].catalogs.find((item) => item.eventKey === "invented-link");
    assert.equal(link.structuralProjectionStatus, "legacy_record_invalid");
    assert.deepEqual(link.fieldDecisions[0].issues, ["href_invalid"]);
    assert.equal(link.fieldDecisions[0].reviewerDecision, null);
    const output = join(root, "decisions.json");
    const script = new URL("../scripts/legacy-import-decision-packet.mjs", import.meta.url).pathname;
    const call = spawnSync(process.execPath, [script, backup, reviewPath, output], { encoding: "utf8" });
    assert.equal(call.status, 0, call.stderr);
    assert.deepEqual(JSON.parse(call.stdout), { status: "private_review_required",
      approvedForImport: false, ownerCount: 1, catalogCount: 3, rows: 5,
      identityDecisions: 3, fieldDecisions: 1, structurallyProjected: 1, structurallyInvalid: 1 });
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), packet);
    assert.notEqual(spawnSync(process.execPath, [script, backup, reviewPath, output]).status, 0);
    review.owners[0].proposedProfileId = "fabricated-profile";
    await writeFile(reviewPath, JSON.stringify(review));
    await assert.rejects(buildLegacyImportDecisionPacket({ backupDir: backup,
      reviewPacketPath: reviewPath }), /legacy_review_packet_mismatch/);
    await assert.rejects(buildLegacyImportDecisionPacket({ backupDir: backup,
      reviewPacketPath: join(root, "missing.json") }));
    const record = manifest.records.find((item) => item.kind === "deployed_html");
    await writeFile(join(backup, "objects", record.objectSha256), "tampered");
    await assert.rejects(buildLegacyImportDecisionPacket({ backupDir: backup,
      reviewPacketPath: reviewPath }), /legacy_backup_byte_mismatch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
