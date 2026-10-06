// Pure dry run. This module neither imports data nor verifies live provider state.
const shaOk = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
const receiptKeys = ["current", "historical", "notesSql"];

function sameReceipt(left, right) {
  return receiptKeys.every((key) => shaOk(left?.[key]) && left[key] === right?.[key]);
}

function evidenceKey(item) {
  return [item.sourceSha256, item.sourcePath, item.eventKey,
    item.rowIndex, item.legacyCompanyId].join("\u0000");
}

function requiredDecision(status) {
  if (status === "current_unique_evidence") return "trusted_profile_and_row_review";
  if (status === "current_ambiguous_quarantine") return "choose_exact_current_row_or_hold";
  if (status === "historical_only_quarantine") return "review_historical_revision_or_hold";
  return "resolve_external_identity_or_hold";
}

export function createLegacyNoteRecoveryPlan({ report, expectedReceipts,
  decisions = [], trustedCatalogs = [], requireComplete = false }) {
  if (!report || report.version !== 1 || !Array.isArray(report.records) ||
      !sameReceipt(report.sourceReceipts, expectedReceipts))
    throw new TypeError("legacy_source_receipt_mismatch");
  if (report.invalidCurrentRows != null && !Array.isArray(report.invalidCurrentRows) ||
      report.invalidHistoricalRows != null && !Array.isArray(report.invalidHistoricalRows))
    throw new TypeError("legacy_recovery_report_invalid");
  if (!Array.isArray(decisions) || !Array.isArray(trustedCatalogs))
    throw new TypeError("legacy_recovery_input_invalid");
  const byPrelead = new Map();
  const validStatuses = new Set(["current_unique_evidence", "current_ambiguous_quarantine",
    "historical_only_quarantine", "known_event_missing_company_quarantine",
    "unknown_event_quarantine", "invalid_note_key_quarantine"]);
  for (const record of report.records) {
    if (!nonempty(record?.preleadId) || byPrelead.has(record.preleadId) ||
        !validStatuses.has(record.status) ||
        !Array.isArray(record.currentCandidates) || !Array.isArray(record.historicalCandidates) ||
        !Number.isSafeInteger(record.dealMessageCount) || record.dealMessageCount < 0)
      throw new TypeError("legacy_recovery_report_invalid");
    byPrelead.set(record.preleadId, record);
  }
  const byDecision = new Map();
  for (const decision of decisions) {
    if (!nonempty(decision?.preleadId) || !byPrelead.has(decision.preleadId) ||
        byDecision.has(decision.preleadId)) throw new TypeError("legacy_recovery_decision_invalid");
    byDecision.set(decision.preleadId, decision);
  }
  const trusted = new Map();
  for (const catalog of trustedCatalogs) {
    if (!shaOk(catalog?.sourceSha256) || !nonempty(catalog.sourcePath) ||
        !nonempty(catalog.eventKey) || !nonempty(catalog.profileRef))
      throw new TypeError("legacy_trusted_catalog_invalid");
    const key = [catalog.sourceSha256, catalog.sourcePath, catalog.eventKey].join("\u0000");
    if (trusted.has(key)) throw new TypeError("legacy_trusted_catalog_duplicate");
    trusted.set(key, catalog.profileRef);
  }
  const summary = { pending_review: 0, held: 0, mapped_for_local_review: 0,
    pendingDealMessages: 0, unmatchedPreleads: 0, unmatchedDealMessages: 0,
    historicalOnlyPreleads: 0, historicalOnlyDealMessages: 0,
    invalidCurrentRows: report.invalidCurrentRows?.length ?? 0,
    invalidHistoricalRows: report.invalidHistoricalRows?.length ?? 0 };
  const records = report.records.map((record) => {
    const decision = byDecision.get(record.preleadId);
    const base = { preleadId: record.preleadId, evidenceStatus: record.status,
      messageCount: record.messageCount ?? null,
      dealMessageCount: record.dealMessageCount,
      currentCandidates: record.currentCandidates,
      historicalCandidates: record.historicalCandidates };
    summary.pendingDealMessages += record.dealMessageCount;
    if (record.status === "historical_only_quarantine") {
      summary.historicalOnlyPreleads++;
      summary.historicalOnlyDealMessages += record.dealMessageCount;
    } else if (record.status === "known_event_missing_company_quarantine" ||
        record.status === "unknown_event_quarantine" ||
        record.status === "invalid_note_key_quarantine") {
      summary.unmatchedPreleads++;
      summary.unmatchedDealMessages += record.dealMessageCount;
    }
    if (!decision) {
      summary.pending_review++;
      return { ...base, status: "pending_review",
        requiredDecision: requiredDecision(record.status) };
    }
    if (!nonempty(decision.reviewRef)) throw new TypeError("legacy_review_reference_required");
    if (decision.kind === "hold" && nonempty(decision.reason)) {
      summary.held++;
      return { ...base, status: "held", reason: decision.reason,
        reviewRef: decision.reviewRef };
    }
    if (decision.kind !== "link_current") throw new TypeError("legacy_recovery_decision_invalid");
    if (!decision.candidate || typeof decision.candidate !== "object")
      throw new TypeError("legacy_exact_current_candidate_required");
    const selected = record.currentCandidates.find((candidate) =>
      evidenceKey(candidate) === evidenceKey(decision.candidate));
    if (!selected) throw new TypeError("legacy_exact_current_candidate_required");
    const catalogKey = [selected.sourceSha256, selected.sourcePath,
      selected.eventKey].join("\u0000");
    const profileRef = trusted.get(catalogKey);
    if (!profileRef || profileRef !== decision.profileRef)
      throw new TypeError("legacy_trusted_profile_mapping_required");
    summary.mapped_for_local_review++;
    return { ...base, status: "mapped_for_local_review",
      selected, profileRef, reviewRef: decision.reviewRef,
      dealLinkGate: record.dealMessageCount ? "verify_existing_provider_deal" : null };
  });
  if (requireComplete && summary.pending_review)
    throw new TypeError("legacy_recovery_decisions_incomplete");
  return { version: 1, sourceReceipts: report.sourceReceipts, summary,
    rowQuarantine: { current: report.invalidCurrentRows ?? [],
      historical: report.invalidHistoricalRows ?? [] }, records };
}
