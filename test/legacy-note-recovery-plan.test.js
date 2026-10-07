import test from "node:test";
import assert from "node:assert/strict";
import { createLegacyNoteRecoveryPlan } from "../src/legacy-note-recovery-plan.js";

const sha = (char) => char.repeat(64);
const sourceReceipts = { current: sha("a"), historical: sha("b"), notesSql: sha("c") };
const candidate = { sourceSha256: sha("d"), sourcePath: "demo/current/index.html",
  eventKey: "invented-expo", rowIndex: 2, legacyCompanyId: "SAMPLE002" };
const report = { version: 1, sourceReceipts, records: [
  { preleadId: "site_invented-expo_sample002", status: "current_unique_evidence",
    currentCandidates: [candidate], historicalCandidates: [], messageCount: 2, dealMessageCount: 1 },
  { preleadId: "site_old-expo_orphan", status: "historical_only_quarantine",
    currentCandidates: [], historicalCandidates: [{ ...candidate,
      sourceSha256: sha("e"), sourcePath: "demo/history/index.html" }],
    messageCount: 1, dealMessageCount: 1 },
  { preleadId: "site_missing_company", status: "unknown_event_quarantine",
    currentCandidates: [], historicalCandidates: [], messageCount: 1, dealMessageCount: 1 }
] };
const trustedCatalogs = [{ sourceSha256: candidate.sourceSha256,
  sourcePath: candidate.sourcePath, eventKey: candidate.eventKey,
  profileRef: "demo-profile-a" }];

test("private dry run retains every invented note and old deal link as pending", () => {
  const plan = createLegacyNoteRecoveryPlan({ report, expectedReceipts: sourceReceipts });
  assert.deepEqual(plan.summary, { pending_review: 3, held: 0,
    mapped_for_local_review: 0, pendingDealMessages: 3,
    unmatchedPreleads: 1, unmatchedDealMessages: 1,
    historicalOnlyPreleads: 1, historicalOnlyDealMessages: 1,
    invalidCurrentRows: 0, invalidHistoricalRows: 0 });
  assert.deepEqual(plan.records.map((item) => item.status),
    ["pending_review", "pending_review", "pending_review"]);
  assert.deepEqual(plan.records.map((item) => item.requiredDecision),
    ["trusted_profile_and_row_review", "review_historical_revision_or_hold",
      "resolve_external_identity_or_hold"]);
  assert.throws(() => createLegacyNoteRecoveryPlan({ report,
    expectedReceipts: sourceReceipts, requireComplete: true }),
  /legacy_recovery_decisions_incomplete/);
});

test("exact source revision and trusted profile are required for a reviewed current row", () => {
  const decisions = [
    { preleadId: report.records[0].preleadId, kind: "link_current", candidate,
      profileRef: "demo-profile-a", reviewRef: "review-001" },
    { preleadId: report.records[1].preleadId, kind: "hold",
      reason: "historical source requires identity review", reviewRef: "review-002" },
    { preleadId: report.records[2].preleadId, kind: "hold",
      reason: "old link preserved outside app D1", reviewRef: "review-003" }
  ];
  const plan = createLegacyNoteRecoveryPlan({ report, expectedReceipts: sourceReceipts,
    decisions, trustedCatalogs, requireComplete: true });
  assert.deepEqual(plan.records.map((item) => item.status),
    ["mapped_for_local_review", "held", "held"]);
  assert.equal(plan.records[0].dealLinkGate, "verify_existing_provider_deal");
  assert.equal(plan.summary.pendingDealMessages, 3);
  assert.throws(() => createLegacyNoteRecoveryPlan({ report,
    expectedReceipts: sourceReceipts, decisions: [{ ...decisions[0],
      candidate: { ...candidate, sourceSha256: sha("f") } }], trustedCatalogs }),
  /legacy_exact_current_candidate_required/);
  assert.throws(() => createLegacyNoteRecoveryPlan({ report,
    expectedReceipts: sourceReceipts, decisions: [{ ...decisions[0],
      profileRef: "wrong-profile" }], trustedCatalogs }),
  /legacy_trusted_profile_mapping_required/);
  assert.throws(() => createLegacyNoteRecoveryPlan({ report,
    expectedReceipts: sourceReceipts, decisions: [{ preleadId: report.records[1].preleadId,
      kind: "link_current", candidate: report.records[1].historicalCandidates[0],
      profileRef: "demo-profile-a", reviewRef: "review-004" }], trustedCatalogs }),
  /legacy_exact_current_candidate_required/);
});

test("changed source receipts or duplicate decisions stop the dry run", () => {
  assert.throws(() => createLegacyNoteRecoveryPlan({ report,
    expectedReceipts: { ...sourceReceipts, notesSql: sha("f") } }),
  /legacy_source_receipt_mismatch/);
  const decision = { preleadId: report.records[2].preleadId, kind: "hold",
    reason: "preserve", reviewRef: "review-001" };
  assert.throws(() => createLegacyNoteRecoveryPlan({ report,
    expectedReceipts: sourceReceipts, decisions: [decision, decision] }),
  /legacy_recovery_decision_invalid/);
});
