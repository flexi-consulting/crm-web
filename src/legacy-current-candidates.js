import { createHash } from "node:crypto";
import { parseLegacyExHtml } from "./private-legacy-handoff.js";
import { legacySitePredealKey } from "./legacy-note-correlation.js";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const safeLegacyId = (id) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id);
function oldOwnerNamespace(path) {
  const match = /^([^/]+)\/(?:projects\/[^/]+\/deploy\/[^/]+|expo-pipeline\/[^/]+)\/index\.html$/.exec(path);
  if (!match || match[1] === "." || match[1] === "..")
    throw new TypeError("legacy_owner_path_invalid");
  return match[1];
}

export async function buildLegacyCurrentCandidateList({ correlationReport,
  verifiedManifest, readObject }) {
  if (correlationReport?.version !== 1 || !Array.isArray(correlationReport.records) ||
      !Array.isArray(verifiedManifest?.records) ||
      verifiedManifest.manifestSha256 !== correlationReport.sourceReceipts?.current ||
      typeof readObject !== "function") throw new TypeError("legacy_candidate_receipt_invalid");
  const catalogByPath = new Map(verifiedManifest.records
    .filter((item) => item.kind === "deployed_html")
    .map((item) => [item.sourcePath, item]));
  const parsedBySha = new Map(), seenPreleads = new Set();
  const summary = { currentUnique: 0, currentAmbiguous: 0, historicalOnly: 0,
    noCatalogRow: 0, dealMessagesOnNoCatalogRow: 0,
    uniqueUnsafeLegacyIds: 0 };
  const candidates = [], quarantine = [];
  for (const record of correlationReport.records) {
    if (typeof record?.preleadId !== "string" || seenPreleads.has(record.preleadId) ||
        !Array.isArray(record.currentCandidates) ||
        !Number.isSafeInteger(record.dealMessageCount) || record.dealMessageCount < 0)
      throw new TypeError("legacy_candidate_report_invalid");
    seenPreleads.add(record.preleadId);
    if (record.status !== "current_unique_evidence") {
      if (record.status === "current_ambiguous_quarantine" && record.currentCandidates.length > 1)
        summary.currentAmbiguous++;
      else if (record.status === "historical_only_quarantine" &&
          record.currentCandidates.length === 0) summary.historicalOnly++;
      else if (["known_event_missing_company_quarantine", "unknown_event_quarantine",
        "invalid_note_key_quarantine"].includes(record.status) &&
        record.currentCandidates.length === 0) {
        summary.noCatalogRow++;
        summary.dealMessagesOnNoCatalogRow += record.dealMessageCount;
      } else throw new TypeError("legacy_candidate_status_invalid");
      quarantine.push({ preleadId: record.preleadId, status: record.status,
        dealMessageCount: record.dealMessageCount,
        currentCandidates: record.currentCandidates,
        historicalCandidates: record.historicalCandidates ?? [] });
      continue;
    }
    if (record.currentCandidates.length !== 1)
      throw new TypeError("legacy_candidate_status_invalid");
    const candidate = record.currentCandidates[0];
    const manifestRow = catalogByPath.get(candidate.sourcePath);
    if (!manifestRow || manifestRow.objectSha256 !== candidate.sourceSha256 ||
        manifestRow.eventKey !== candidate.eventKey)
      throw new TypeError("legacy_candidate_source_mismatch");
    let parsed = parsedBySha.get(candidate.sourceSha256);
    if (!parsed) {
      const bytes = await readObject(candidate.sourceSha256);
      if (!Buffer.isBuffer(bytes) || sha(bytes) !== candidate.sourceSha256)
        throw new TypeError("legacy_candidate_byte_mismatch");
      parsed = parseLegacyExHtml(bytes);
      parsedBySha.set(candidate.sourceSha256, parsed);
    }
    if (parsed.eventKey !== candidate.eventKey ||
        !Number.isSafeInteger(candidate.rowIndex) || candidate.rowIndex < 0 ||
        parsed.entries[candidate.rowIndex]?.id !== candidate.legacyCompanyId ||
        legacySitePredealKey(candidate.eventKey, candidate.legacyCompanyId) !== record.preleadId)
      throw new TypeError("legacy_candidate_identity_mismatch");
    const legacyIdSafe = safeLegacyId(candidate.legacyCompanyId);
    summary.currentUnique++;
    if (!legacyIdSafe) summary.uniqueUnsafeLegacyIds++;
    candidates.push({ preleadId: record.preleadId,
      sourceSha256: candidate.sourceSha256, sourcePath: candidate.sourcePath,
      eventKey: candidate.eventKey, rowIndex: candidate.rowIndex,
      legacyCompanyId: candidate.legacyCompanyId,
      oldOwnerNamespace: oldOwnerNamespace(candidate.sourcePath),
      ownerEvidence: "legacy_users_USER_ID_directory",
      trustedProfileRef: null, reviewStatus: "pending_profile_owner_review",
      legacyIdSafe, dealMessageCount: record.dealMessageCount });
  }
  return { version: 1, sourceReceipts: correlationReport.sourceReceipts,
    summary, candidates, quarantine };
}
