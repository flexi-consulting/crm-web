import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildLegacyProfileReviewPacket } from "../src/legacy-profile-review-packet.js";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const manifest = { version: 1, records: [
  { kind: "source_json", sourcePath: "legacy-alpha/data.json", eventKey: "demo-expo-001",
    objectSha256: hash("source") },
  { kind: "deployed_html", sourcePath: "legacy-beta/demo-expo-002/index.html",
    eventKey: "demo-expo-002", objectSha256: hash("beta") },
  { kind: "deployed_html", sourcePath: "legacy-alpha/demo-expo-001/index.html",
    eventKey: "demo-expo-001", objectSha256: hash("alpha") }
] };

test("review packet groups exact catalogs, pins source bytes, and approves nothing", () => {
  const receipt = hash(JSON.stringify(manifest));
  const packet = buildLegacyProfileReviewPacket(manifest, receipt);
  assert.deepEqual(packet.owners.map(({ legacyUserId }) => legacyUserId),
    ["legacy-alpha", "legacy-beta"]);
  assert.equal(packet.owners[0].catalogs.length, 1);
  assert.equal(packet.owners[0].catalogs[0].objectSha256, hash("alpha"));
  assert.equal(packet.owners[0].proposedProfileId, null);
  assert.equal(packet.owners[0].reviewerDecision, "pending");
  assert.equal(packet.approvedForImport, false);
  assert.equal(packet.manifestSha256, receipt);
});

test("duplicate paths and unsafe old owner identifiers stop before a review packet", () => {
  assert.throws(() => buildLegacyProfileReviewPacket({ version: 1,
    records: [...manifest.records, manifest.records[2]] }, hash("x")), /catalog_invalid/);
  assert.throws(() => buildLegacyProfileReviewPacket({ version: 1,
    records: [{ ...manifest.records[2], sourcePath: "../legacy-alpha/index.html" }] },
  hash("x")), /catalog_invalid/);
  assert.throws(() => buildLegacyProfileReviewPacket({ version: 1, records: [] }, hash("x")),
    /catalog_empty/);
});

test("CLI checks exact manifest receipt and creates only a private owner-only packet", () => {
  const dir = mkdtempSync(join(tmpdir(), "crm-profile-review-"));
  try {
    const manifestPath = join(dir, "manifest.json"), output = join(dir, "review.json");
    const bytes = JSON.stringify(manifest) + "\n";
    writeFileSync(manifestPath, bytes);
    const script = new URL("../scripts/legacy-profile-review-packet.mjs", import.meta.url).pathname;
    const bad = spawnSync(process.execPath, [script, manifestPath, hash("wrong"), output],
      { encoding: "utf8" });
    assert.notEqual(bad.status, 0);
    assert.equal(existsSync(output), false);
    const good = spawnSync(process.execPath, [script, manifestPath, hash(bytes), output],
      { encoding: "utf8" });
    assert.equal(good.status, 0, good.stderr);
    assert.deepEqual(JSON.parse(good.stdout), { status: "manual_review_required",
      catalogCount: 2, ownerCount: 2, approvedForImport: false });
    assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(output)).manifestSha256, hash(bytes));
    assert.notEqual(spawnSync(process.execPath, [script, manifestPath, hash(bytes), output]).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
