import { createHash } from "node:crypto";
import { validateReport } from "./catalog-build.js";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const eventKeyOk = (value) => typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value);
const legacyIdOk = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
const text = (value, max) => typeof value === "string" && value.trim() &&
  [...value.trim()].length <= max ? value.trim() : null;
const optionalText = (value, max) => value == null || value === "" ? null : text(value, max);
function url(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || /\s/.test(value)) return undefined;
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) && parsed.hostname &&
      !parsed.username && !parsed.password ? parsed.href : undefined;
  } catch { return undefined; }
}
const innOk = (value) => value == null || value === "" || typeof value === "string" && /^\d{10,12}$/.test(value);
const ogrnOk = (value) => value == null || value === "" || typeof value === "string" && /^\d{13,15}$/.test(value);
const money = (value) => value == null || value === "" ? null :
  typeof value === "number" && Number.isFinite(value) && value >= 0 &&
  Number.isSafeInteger(Math.round(value * 1_000_000)) ? Math.round(value * 1_000_000) : undefined;

// The private preflight uses these same checks to point reviewers to exact
// source rows without importing, normalizing, or publishing their values.
export function inspectLegacyExRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return ["row_invalid"];
  const issues = [];
  if (!text(row.n, 240)) issues.push("name_invalid");
  if (optionalText(row.s, 80) === null && row.s != null && row.s !== "") issues.push("booth_invalid");
  if (![0, 1].includes(row.t) || ![0, 1].includes(row.nt) || row.t + row.nt > 1 ||
      ![0, 1].includes(row.ru) || row.t === 1 && (row.ru !== 1 || !row.inn))
    issues.push("classification_invalid");
  if (!innOk(row.inn)) issues.push("inn_invalid");
  if (!ogrnOk(row.ogrn)) issues.push("ogrn_invalid");
  if (money(row.rev) === undefined) issues.push("revenue_invalid");
  if (url(row.href) === undefined) issues.push("href_invalid");
  if (url(row.w) === undefined) issues.push("website_invalid");
  return issues;
}

// Input is the parsed EX array emitted by the legacy catalog generator, not
// arbitrary HTML. Phone/email/contact fields are deliberately not imported.
export function projectLegacyExSnapshot({ profileRef, eventKey, entries }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(profileRef ?? "") ||
      !eventKeyOk(eventKey) || !Array.isArray(entries) || entries.length < 1 || entries.length > 20_000)
    return { status: "invalid_snapshot" };
  const seen = new Set();
  for (const row of entries) {
    if (!row || typeof row !== "object" || Array.isArray(row) || !legacyIdOk(row.id) || seen.has(row.id))
      return { status: "legacy_identity_conflict" };
    seen.add(row.id);
    if (inspectLegacyExRow(row).length)
      return { status: "legacy_record_invalid" };
  }
  const included = entries.map(({ id, n, s, t, nt, inn, ogrn, ru, rev, href, w, country }) =>
    ({ id, n, s, t, nt, inn, ogrn, ru, rev, href, w, country }));
  const sourceRevision = `legacy-ex-sha256-${sha(JSON.stringify([eventKey, included]))}`;
  const fixtureRef = sourceRevision;
  const companies = entries.map((row) => {
    const id = `co-${sha(JSON.stringify([eventKey, row.id])).slice(0, 20)}`;
    const sourceRecordId = `src-${sha(JSON.stringify([eventKey, row.id])).slice(0, 24)}`;
    const country = row.ru === 1 ? "RU" : text(row.country, 80) ?? "unknown";
    const revenueRub = money(row.rev);
    const inn = row.inn || null, ogrn = row.ogrn || null;
    const classification = row.t === 1 ? "target" : row.nt === 1 ? "near_target" : "not_target";
    return { id, name: row.n.trim().replace(/\s+/g, " "),
      source: { sourceRecordId, country, booth: optionalText(row.s, 80), href: url(row.href),
        duplicateSourceRecordIds: [] },
      enrichment: { status: inn || ogrn || revenueRub !== null || url(row.w) ? "found" : "not_found",
        inn, ogrn, revenueRub, activity: "unknown", website: url(row.w),
        provenance: { provider: "legacy-ex-snapshot", fixtureRef } },
      registry: { status: "unknown", provenance: { source: "legacy-ex-snapshot", fixtureRef } },
      qualification: { classification, target: row.t === 1, nearTarget: row.nt === 1,
        reason: "legacy_classification_unverified" } };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const artifact = { schemaVersion: "1.0.0", exhibitionId: eventKey, sourceRevision, companies };
  const report = { schemaVersion: "1.0.0", exhibitionId: eventKey, sourceRevision,
    stages: { source: { status: "complete", imported: entries.length },
      dedup: { status: "complete", removed: 0 },
      enrichment: { status: "partial" }, registry: { status: "partial" },
      qualification: { status: "complete" }, artifact: { status: "complete" } },
    providerErrors: [], validation: null };
  report.validation = validateReport(artifact, report);
  if (!report.validation.valid) return { status: "legacy_projection_invalid" };
  const buildId = `build-${sha(JSON.stringify([profileRef, eventKey, sourceRevision])).slice(0, 24)}`;
  const legacyRefs = entries.map((row) => ({ legacyId: row.id,
    companyId: `co-${sha(JSON.stringify([eventKey, row.id])).slice(0, 20)}` }));
  return { status: "projected", idempotencyKey: `legacy:${sha(JSON.stringify([eventKey, sourceRevision])).slice(0, 32)}`,
    build: { buildId, artifact, report }, legacyRefs };
}

export async function importLegacyExSnapshot({ repository, profileRef, eventKey, entries }) {
  if (!repository?.saveBuild || !repository?.resolveLegacyParticipant) throw new Error("catalog_repository_required");
  const projected = projectLegacyExSnapshot({ profileRef, eventKey, entries });
  if (projected.status !== "projected") return { status: projected.status };
  const saved = await repository.saveBuild({ profileRef, idempotencyKey: projected.idempotencyKey,
    build: projected.build, legacyRefs: projected.legacyRefs });
  return { status: saved.status, buildId: saved.buildId, sourceRevision: projected.build.artifact.sourceRevision,
    imported: projected.legacyRefs.length };
}
