import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildLegacyCurrentCandidateList } from "../src/legacy-current-candidates.js";

const html = Buffer.from(`<script>const EX = [{"id":"SAMPLE001","n":"Invented Maker"}];\nconst EVENT_KEY = 'demo-expo';</script>`);
const sourceSha256 = createHash("sha256").update(html).digest("hex");
const sourcePath = "demo-old-user/projects/demo-project/deploy/demo-expo/index.html";
const candidate = { sourceSha256, sourcePath, eventKey: "demo-expo",
  rowIndex: 0, legacyCompanyId: "SAMPLE001" };
const sourceReceipts = { current: "a".repeat(64), historical: "b".repeat(64),
  notesSql: "c".repeat(64) };
const verifiedManifest = { manifestSha256: sourceReceipts.current, records: [
  { kind: "deployed_html", sourcePath, objectSha256: sourceSha256,
    eventKey: "demo-expo", bytes: html.length }
] };
const correlationReport = { version: 1, sourceReceipts, records: [
  { preleadId: "site_demo-expo_sample001", status: "current_unique_evidence",
    currentCandidates: [candidate], historicalCandidates: [], dealMessageCount: 1 },
  { preleadId: "site_demo-expo_collision", status: "current_ambiguous_quarantine",
    currentCandidates: [candidate, { ...candidate, rowIndex: 1 }],
    historicalCandidates: [], dealMessageCount: 0 },
  { preleadId: "site_old-expo_old001", status: "historical_only_quarantine",
    currentCandidates: [], historicalCandidates: [{ ...candidate,
      sourceSha256: "d".repeat(64) }], dealMessageCount: 1 },
  { preleadId: "site_unknown-missing", status: "unknown_event_quarantine",
    currentCandidates: [], historicalCandidates: [], dealMessageCount: 2 }
] };
const readObject = async () => html;

test("exact current row yields old USER_ID namespace evidence without trusted profile binding", async () => {
  const list = await buildLegacyCurrentCandidateList({ correlationReport,
    verifiedManifest, readObject });
  assert.deepEqual(list.summary, { currentUnique: 1, currentAmbiguous: 1,
    historicalOnly: 1, noCatalogRow: 1, dealMessagesOnNoCatalogRow: 2,
    uniqueUnsafeLegacyIds: 0 });
  assert.equal(list.candidates[0].oldOwnerNamespace, "demo-old-user");
  assert.equal(list.candidates[0].trustedProfileRef, null);
  assert.equal(list.candidates[0].reviewStatus, "pending_profile_owner_review");
  assert.equal(list.quarantine.length, 3);
});

test("changed bytes, source revision or row identity fail the entire list", async () => {
  await assert.rejects(buildLegacyCurrentCandidateList({ correlationReport,
    verifiedManifest, readObject: async () => Buffer.concat([html, Buffer.from(" ")]) }),
  /legacy_candidate_byte_mismatch/);
  await assert.rejects(buildLegacyCurrentCandidateList({ correlationReport,
    verifiedManifest: { ...verifiedManifest, manifestSha256: "f".repeat(64) }, readObject }),
  /legacy_candidate_receipt_invalid/);
  await assert.rejects(buildLegacyCurrentCandidateList({ correlationReport: {
    ...correlationReport, records: [{ ...correlationReport.records[0],
      currentCandidates: [{ ...candidate, rowIndex: 1 }] }] },
  verifiedManifest, readObject }), /legacy_candidate_identity_mismatch/);
  await assert.rejects(buildLegacyCurrentCandidateList({ correlationReport: {
    ...correlationReport, records: [{ ...correlationReport.records[0],
      currentCandidates: [{ ...candidate, sourcePath: "other/index.html" }] }] },
  verifiedManifest, readObject }), /legacy_candidate_source_mismatch/);
});
