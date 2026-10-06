import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { prepareApprovedLegacyImport } from "../src/legacy-import-approval.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const rows = [
  { id: "SYN001", n: "Invented Loom Works", s: "A-01", t: 1, nt: 0, inn: "0000000001", ogrn: "0000000000001", ru: 1, rev: 250,
    href: "https://example.invalid/loom", w: "https://example.invalid" },
  { id: "SYN002", n: "Invented Parts", s: "A-02", t: 0, nt: 1, ru: 1, rev: null }
];
const sourceSha256 = "a".repeat(64), manifestSha256 = "b".repeat(64), profileEvidenceSha256 = "c".repeat(64);
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
  eventKey: "invented-expo-2026", profileBinding, entries: rows, decisions: decisions(), ...overrides });

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
  assert.equal(prepareApprovedLegacyImport(args({ sourceSha256: "f".repeat(64) })).status, "source_not_in_review_packet");
  assert.equal(prepareApprovedLegacyImport(args({ sourcePath: "other/catalog.html" })).status, "source_not_in_review_packet");
  assert.equal(prepareApprovedLegacyImport(args({ eventKey: "other-expo" })).status, "source_not_in_review_packet");
});
