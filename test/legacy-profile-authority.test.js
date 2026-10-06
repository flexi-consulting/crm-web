import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { auditLegacyProfileAuthority } from "../src/legacy-profile-authority.js";

const H = "a".repeat(64), J = "b".repeat(64);
const fixture = () => ({
  manifest: { version: 1, records: [
    { kind: "deployed_html", sourcePath: "legacy-a/projects/expo/deploy/event-a/index.html",
      objectSha256: H, eventKey: "event-a" },
    { kind: "deployed_html", sourcePath: "legacy-b/expo-pipeline/event-b/index.html",
      objectSha256: J, eventKey: "event-b" }] },
  authority: { schemaVersion: 1, principals: [
    { principalId: "principal-a", profileId: "profile-a", keyHash: H, scopes: [] },
    { principalId: "principal-b", profileId: "profile-b", keyHash: J, scopes: [] }] },
  mapping: { version: 1, manifestSha256: H, authoritySha256: H, notesSha256: H,
    bindings: [
      { legacyUserId: "legacy-a", principalId: "principal-a", profileId: "profile-a",
        evidenceRef: "reviewed-agent-profile-record-a", evidenceSha256: H },
      { legacyUserId: "legacy-b", principalId: "principal-b", profileId: "profile-b",
        evidenceRef: "reviewed-agent-profile-record-b", evidenceSha256: J }] },
  notes: { candidates: [
    { preleadId: "site_event-a_company-a", sourcePath: "legacy-a/projects/expo/deploy/event-a/index.html",
      sourceSha256: H, eventKey: "event-a", oldOwnerNamespace: "legacy-a", trustedProfileRef: "profile-a" }],
    quarantine: [{ preleadId: "site_event-c_company-x" }] }
});

test("only exact source receipt and trusted principal mapping complete identity evidence", () => {
  const report = auditLegacyProfileAuthority(fixture());
  assert.equal(report.totals.catalogBindingCandidates, 2);
  assert.equal(report.totals.noteBindingCandidates, 1);
  assert.equal(report.totals.noteQuarantined, 1);
  assert.equal(report.approvedForImport, false);
});

test("path alone, changed source revision and mismatched trusted profile never link notes", () => {
  const value = fixture();
  value.mapping.bindings.pop();
  value.notes.candidates.push({ preleadId: "site_event-b_company-b",
    sourcePath: "legacy-b/expo-pipeline/event-b/index.html", sourceSha256: J,
    eventKey: "event-b", oldOwnerNamespace: "legacy-b", trustedProfileRef: "profile-b" });
  value.notes.candidates.push({ preleadId: "site_event-a_company-c",
    sourcePath: "legacy-a/projects/expo/deploy/event-a/index.html", sourceSha256: J,
    eventKey: "event-a", oldOwnerNamespace: "legacy-a", trustedProfileRef: "profile-a" });
  value.notes.candidates[0].trustedProfileRef = "profile-b";
  const totals = auditLegacyProfileAuthority(value).totals;
  assert.equal(totals.catalogOwnerBindingMissing, 1);
  assert.equal(totals.noteOwnerBindingMissing, 1);
  assert.equal(totals.noteSourceMismatch, 1);
  assert.equal(totals.noteAuthorityMismatch, 1);
  assert.equal(totals.noteBindingCandidates, 0);
});

test("ambiguous or conflicting authority and duplicate notes fail closed", () => {
  const manyToOne = fixture();
  manyToOne.mapping.bindings[1].profileId = "profile-a";
  assert.throws(() => auditLegacyProfileAuthority(manyToOne), /many_to_one/);
  const conflict = fixture();
  conflict.authority.principals[1].principalId = "principal-a";
  assert.throws(() => auditLegacyProfileAuthority(conflict), /authority_conflict/);
  const duplicate = fixture();
  duplicate.notes.quarantine[0].preleadId = duplicate.notes.candidates[0].preleadId;
  assert.throws(() => auditLegacyProfileAuthority(duplicate), /note_duplicate/);
});

test("owner-only CLI checks exact input byte receipts and never approves import", () => {
  const dir = mkdtempSync(join(tmpdir(), "crm-identity-audit-"));
  const value = fixture();
  const paths = ["manifest", "authority", "mapping", "notes"]
    .map((part) => join(dir, `${part}.json`));
  for (const part of ["manifest", "authority", "notes"])
    writeFileSync(join(dir, `${part}.json`), JSON.stringify(value[part]));
  for (const part of ["manifest", "authority", "notes"])
    value.mapping[`${part}Sha256`] = createHash("sha256")
      .update(readFileSync(join(dir, `${part}.json`))).digest("hex");
  writeFileSync(paths[2], JSON.stringify(value.mapping));
  const output = join(dir, "report.json");
  const command = ["scripts/legacy-profile-authority.mjs", ...paths, output];
  const good = spawnSync(process.execPath, command, { encoding: "utf8" });
  assert.equal(good.status, 0, good.stderr);
  assert.equal(JSON.parse(readFileSync(output)).approvedForImport, false);
  assert.equal(statSync(output).mode & 0o777, 0o600);
  writeFileSync(paths[3], JSON.stringify({ ...value.notes, quarantine: [] }));
  const bad = spawnSync(process.execPath, [...command.slice(0, -1), join(dir, "tampered-report.json")],
    { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /source_receipt_mismatch/);
  assert.doesNotMatch(bad.stderr, /legacy-a|site_event/);
});
