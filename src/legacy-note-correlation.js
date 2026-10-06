import { createHash } from "node:crypto";
import { parseLegacyExHtml } from "./private-legacy-handoff.js";

// Offline evidence only. A match is never an authorization to restore a note or deal link.
const segment = (value) => String(value ?? "").trim()
  .replace(/[^\w.-]+/gu, "-").replace(/-+/gu, "-")
  .replace(/^-|-$/gu, "").slice(0, 80) || "item";

// Must match the old bot's sitePredealId() / safePathSegment() behavior.
export function legacySitePredealKey(eventKey, companyId) {
  return `site_${segment(eventKey)}_${segment(companyId)}`.toLowerCase();
}

export function classifyHistoricalExArtifact({ bytes, sourcePath }) {
  if (!Buffer.isBuffer(bytes) || typeof sourcePath !== "string" || !sourcePath)
    throw new TypeError("legacy_html_artifact_invalid");
  const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
  const provenance = { sourcePath, sourceSha256,
    sourceRevision: `legacy-html-sha256:${sourceSha256}` };
  if (/\bconst EX\s*=\s*\{\{EX_JSON\}\}\s*;/.test(bytes.toString("utf8")))
    return { status: "template_quarantine", ...provenance };
  try {
    const { eventKey, entries } = parseLegacyExHtml(bytes);
    return { status: "catalog_evidence", ...provenance, eventKey, entries };
  } catch {
    return { status: "unparsed_quarantine", ...provenance };
  }
}

function indexedCatalogs(catalogs) {
  if (!Array.isArray(catalogs)) throw new TypeError("legacy_catalogs_invalid");
  const byNoteId = new Map(), eventPrefixes = new Set();
  for (const catalog of catalogs) {
    if (!catalog || typeof catalog.eventKey !== "string" || !catalog.eventKey.trim() ||
        !/^[a-f0-9]{64}$/.test(catalog.sourceSha256 ?? "") ||
        !Array.isArray(catalog.entries)) throw new TypeError("legacy_catalog_invalid");
    const prefix = `site_${segment(catalog.eventKey)}_`.toLowerCase();
    eventPrefixes.add(prefix);
    catalog.entries.forEach((entry, rowIndex) => {
      if (!entry || typeof entry.id !== "string" || !entry.id.trim())
        throw new TypeError("legacy_catalog_row_invalid");
      const key = legacySitePredealKey(catalog.eventKey, entry.id);
      const candidates = byNoteId.get(key) ?? [];
      candidates.push({ sourceSha256: catalog.sourceSha256, rowIndex,
        profileRef: catalog.profileRef ?? null, eventKey: catalog.eventKey,
        legacyCompanyId: entry.id });
      byNoteId.set(key, candidates);
    });
  }
  return { byNoteId, eventPrefixes };
}

export function correlateLegacySiteNotes({ currentCatalogs, historicalCatalogs = [], preleadIds }) {
  if (!Array.isArray(preleadIds) || preleadIds.some((id) => typeof id !== "string"))
    throw new TypeError("legacy_prelead_ids_invalid");
  const current = indexedCatalogs(currentCatalogs);
  const historical = indexedCatalogs(historicalCatalogs);
  const prefixes = [...current.eventPrefixes, ...historical.eventPrefixes];
  return preleadIds.map((preleadId) => {
    const currentCandidates = current.byNoteId.get(preleadId) ?? [];
    const historicalCandidates = historical.byNoteId.get(preleadId) ?? [];
    let status;
    if (currentCandidates.length === 1) status = "current_unique_evidence";
    else if (currentCandidates.length > 1) status = "current_ambiguous_quarantine";
    else if (historicalCandidates.length) status = "historical_only_quarantine";
    else if (!preleadId.startsWith("site_") || preleadId.length <= 5)
      status = "invalid_note_key_quarantine";
    else if (prefixes.some((prefix) => preleadId.startsWith(prefix)))
      status = "known_event_missing_company_quarantine";
    else status = "unknown_event_quarantine";
    return { preleadId, status, currentCandidates, historicalCandidates };
  });
}

export function summarizeLegacyNoteCorrelation(results) {
  if (!Array.isArray(results)) throw new TypeError("legacy_correlation_invalid");
  const counts = {};
  for (const result of results) {
    if (typeof result?.status !== "string") throw new TypeError("legacy_correlation_invalid");
    counts[result.status] = (counts[result.status] ?? 0) + 1;
  }
  return counts;
}
