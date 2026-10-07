import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { importReviewedLegacyExSnapshot, prepareApprovedLegacyImport } from "../src/legacy-import-approval.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const rows = [
  { id: "SYN001", n: "Invented Loom Works", s: "A-01", t: 1, nt: 0, inn: "0000000001", ogrn: "0000000000001", ru: 1, rev: 250,
    href: "https://example.invalid/loom", w: "https://example.invalid" },
  { id: "SYN002", n: "Invented Parts", s: "A-02", t: 0, nt: 1, ru: 1, rev: null }
];
const sourceBytes = Buffer.from(`const EVENT_KEY = 'invented-expo-2026';\nconst EX = ${JSON.stringify(rows)};\n`);
const sourceSha256 = hash(sourceBytes), manifestSha256 = "b".repeat(64), profileEvidenceSha256 = "c".repeat(64);
const packet = { version: 1, status: "private_review_required", approvedForImport: false, manifestSha256,
  owners: [{ legacyUserId: "old-owner-01", proposedPrincipalId: null, proposedProfileId: null,
    reviewerDecision: "pending", catalogs: [{ sourcePath: "old-owner-01/catalog.html", sourceSha256, eventKey: "invented-expo-2026" }] }] };
const profileBinding = { status: "confirmed", issuer: "control-plane", legacyUserId: "old-owner-01",
  principalId: "principal-01", profileId: "profile-01", evidenceSha256: profileEvidenceSha256 };
const decisions = (sourceRows = rows) => ({ version: 1, status: "reviewed", packetSha256: hash(JSON.stringify(packet)),
  manifestSha256, sourcePath: "old-owner-01/catalog.html", sourceSha256, eventKey: "invented-expo-2026",
  legacyUserId: "old-owner-01", profileId: "profile-01", principalId: "principal-01",
  profileBindingEvidenceSha256: profileEvidenceSha256,
  reviewerEvidenceSha256: "d".repeat(64), rows: sourceRows.map((row, index) => ({ index,
    rowSha256: hash(JSON.stringify(row)), outcome: "include", replacement: row, evidenceSha256: "e".repeat(64) })) });
const args = (overrides = {}) => ({ packet, manifestSha256, sourceSha256, sourcePath: "old-owner-01/catalog.html",
  eventKey: "invented-expo-2026", profileBinding, sourceBytes, decisions: decisions(), ...overrides });

test("review gate binds exact source, complete row decisions, CP profile evidence and produces only a projection", () => {
  const result = prepareApprovedLegacyImport(args());
  assert.equal(result.status, "reviewed_projection_ready");
  assert.equal(result.includedRows, 2);
  assert.equal(result.build.artifact.companies.length, 2);
  assert.equal(result.profileId, "profile-01");
  assert.equal(packet.approvedForImport, false);
});

test("rejects absent or mismatched CP profile authority and reviewer receipt", () => {
  assert.equal(prepareApprovedLegacyImport(args({ profileBinding: null })).status, "profile_binding_unverified");
  assert.equal(prepareApprovedLegacyImport(args({ profileBinding: { ...profileBinding, profileId: "guessed" } })).status, "review_decisions_unverified");
  assert.equal(prepareApprovedLegacyImport(args({ decisions: { ...decisions(), profileBindingEvidenceSha256: "f".repeat(64) } })).status, "review_decisions_unverified");
});

test("requires exactly one byte-bound decision for every source row", () => {
  const missing = decisions(); missing.rows.pop();
  assert.equal(prepareApprovedLegacyImport(args({ decisions: missing })).status, "row_decision_coverage_invalid");
  const duplicate = decisions(); duplicate.rows[1] = { ...duplicate.rows[0] };
  assert.equal(prepareApprovedLegacyImport(args({ decisions: duplicate })).status, "row_decision_coverage_invalid");
  const tampered = decisions(); tampered.rows[0].rowSha256 = "f".repeat(64);
  assert.equal(prepareApprovedLegacyImport(args({ decisions: tampered })).status, "row_decision_row_binding_invalid");
});

test("only explicit evidence-backed exclusion or complete valid replacement can project", () => {
  const excluded = decisions();
  excluded.rows[1] = { ...excluded.rows[1], outcome: "exclude", reason: "synthetic reviewer exclusion" };
  delete excluded.rows[1].replacement;
  assert.equal(prepareApprovedLegacyImport(args({ decisions: excluded })).excludedSourceIndexes[0], 1);
  const invalid = decisions();
  invalid.rows[0] = { ...invalid.rows[0], replacement: { ...rows[0], href: "javascript:alert(1)" } };
  assert.equal(prepareApprovedLegacyImport(args({ decisions: invalid })).status, "legacy_record_invalid");
  const duplicate = decisions();
  duplicate.rows[1] = { ...duplicate.rows[1], replacement: { ...rows[1], id: rows[0].id } };
  assert.equal(prepareApprovedLegacyImport(args({ decisions: duplicate })).status, "legacy_identity_conflict");
});

test("binds decision packet to exact owner, source path, source bytes, and event", () => {
  assert.equal(prepareApprovedLegacyImport(args({ sourceSha256: "f".repeat(64) })).status, "source_bytes_mismatch");
  assert.equal(prepareApprovedLegacyImport(args({ sourcePath: "other/catalog.html" })).status, "source_not_in_review_packet");
  assert.equal(prepareApprovedLegacyImport(args({ eventKey: "other-expo" })).status, "source_event_mismatch");
});

test("writes the approved projection through the app-owned repository and reports replay safely", async () => {
  const calls = [];
  const repository = { async saveBuild(input) {
    calls.push(input);
    return { status: calls.length === 1 ? "stored" : "replay", buildId: input.build.buildId };
  } };
  const first = await importReviewedLegacyExSnapshot({ repository, ...args() });
  const replay = await importReviewedLegacyExSnapshot({ repository, ...args() });
  assert.equal(first.status, "stored");
  assert.equal(replay.status, "replay");
  assert.equal(first.imported, 2);
  assert.equal(calls[0].profileRef, "profile-01");
  assert.equal(calls[0].idempotencyKey, calls[1].idempotencyKey);
  assert.equal(calls[0].build.artifact.sourceRevision, first.sourceRevision);
  assert.deepEqual(calls[0].legacyRefs, calls[1].legacyRefs);
});

test("does not call persistence when any source row lacks an approved decision", async () => {
  let calls = 0;
  const result = await importReviewedLegacyExSnapshot({ repository: { async saveBuild() { calls++; } },
    ...args({ decisions: { ...decisions(), rows: decisions().rows.slice(0, 1) } }) });
  assert.equal(result.status, "row_decision_coverage_invalid");
  assert.equal(calls, 0);
});
