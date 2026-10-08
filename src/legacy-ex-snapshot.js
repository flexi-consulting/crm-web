import { createHash } from "node:crypto";
import { validateReport } from "./catalog-build.js";
import { CATALOG_BUILD_SCHEMA_VERSION } from "./catalog-version.js";

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
const legacyMoneyRub = (value, { allowNegative = false } = {}) => value == null || value === "" ? null :
  typeof value === "number" && Number.isFinite(value) && (allowNegative || value >= 0) &&
  Number.isSafeInteger(Math.round(value * 1_000_000)) ? Math.round(value * 1_000_000) : undefined;
const legacyYear = value => value == null || value === "" ? null :
  Number.isInteger(value) && value >= 1900 && value <= 2200 ? value : undefined;
const validOptionalText = (value, max) => value == null || value === "" ||
  typeof value === "string" && !!value.trim() && [...value.trim()].length <= max;
const legacyCategory = (row) => {
  if (row.cat != null && row.cat !== "") return optionalText(row.cat, 240);
  if (row.cats == null) return null;
  if (!Array.isArray(row.cats)) return undefined;
  const categories = row.cats.map(value => text(value, 240));
  return categories.some(value => !value) ? undefined : optionalText(categories.join(", "), 240);
};

// The private preflight uses these same checks to point reviewers to exact
// source rows without importing, normalizing, or publishing their values.
export function inspectLegacyExRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return ["row_invalid"];
  const issues = [];
  if (!text(row.n, 240)) issues.push("name_invalid");
  if (optionalText(row.s, 80) === null && row.s != null && row.s !== "") issues.push("booth_invalid");
  const validFlag = (value) => value == null || value === 0 || value === 1;
  if (!validFlag(row.t) || !validFlag(row.nt) || row.t === 1 && row.nt === 1 ||
      ![0, 1].includes(row.ru))
    issues.push("classification_invalid");
  if (!innOk(row.inn)) issues.push("inn_invalid");
  if (!ogrnOk(row.ogrn)) issues.push("ogrn_invalid");
  if (money(row.rev) === undefined) issues.push("revenue_invalid");
  if (legacyMoneyRub(row.prof, { allowNegative: true }) === undefined) issues.push("profit_invalid");
  if (legacyYear(row.ry) === undefined || legacyYear(row.py) === undefined) issues.push("financial_year_invalid");
  if (legacyCategory(row) === undefined) issues.push("category_invalid");
  if (!validOptionalText(row.b, 2000)) issues.push("description_invalid");
  if (!validOptionalText(row.seg, 120)) issues.push("segment_invalid");
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
  const included = entries.map(row => ({ id: row.id, n: row.n, s: row.s, t: row.t, nt: row.nt,
    inn: row.inn, ogrn: row.ogrn, ru: row.ru, rev: row.rev, href: row.href, w: row.w,
    country: row.country, cat: legacyCategory(row), b: optionalText(row.b, 2000),
    seg: optionalText(row.seg, 120), prof: row.prof, ry: row.ry, py: row.py }));
  const sourceRevision = `legacy-ex-sha256-${sha(JSON.stringify([eventKey, included]))}`;
  const fixtureRef = sourceRevision;
  const companies = entries.map((row) => {
    const id = `co-${sha(JSON.stringify([eventKey, row.id])).slice(0, 20)}`;
    const sourceRecordId = `src-${sha(JSON.stringify([eventKey, row.id])).slice(0, 24)}`;
    const country = row.ru === 1 ? "RU" : text(row.country, 80) ?? "unknown";
    const revenueRub = money(row.rev);
    const profitRub = legacyMoneyRub(row.prof, { allowNegative: true });
    const inn = row.inn || null, ogrn = row.ogrn || null;
    const classification = row.t === 1 ? "target" : row.nt === 1 ? "near_target" :
      row.t === 0 && row.nt === 0 ? "not_target" : "unknown";
    return { id, name: row.n.trim().replace(/\s+/g, " "),
      source: { sourceRecordId, country, booth: optionalText(row.s, 80), href: url(row.href),
        category: legacyCategory(row), description: optionalText(row.b, 2000),
        segment: optionalText(row.seg, 120),
        duplicateSourceRecordIds: [] },
      enrichment: { status: inn || ogrn || revenueRub !== null || profitRub !== null || url(row.w) ? "found" : "not_found",
        inn, ogrn, revenueRub, revenueYear: legacyYear(row.ry), profitRub, profitYear: legacyYear(row.py),
        activity: "unknown", website: url(row.w),
        provenance: { provider: "legacy-ex-snapshot", fixtureRef } },
      registry: { status: "unknown", provenance: { source: "legacy-ex-snapshot", fixtureRef } },
      qualification: { classification, target: classification === "target", nearTarget: classification === "near_target",
        reason: "legacy_classification_unverified" } };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const artifact = { schemaVersion: CATALOG_BUILD_SCHEMA_VERSION, exhibitionId: eventKey, sourceRevision, companies };
  const report = { schemaVersion: CATALOG_BUILD_SCHEMA_VERSION, exhibitionId: eventKey, sourceRevision,
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

// Explicit, synthetic-testable projection for the app-owned v1.1 display contract.
// Legacy financial amounts are in RUB millions; their source years are retained
// only when present. Unknown input fields (including contacts) never enter the
// canonical artifact or its source revision.
export function projectLegacyExSnapshotV11({ profileRef, eventKey, entries }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(profileRef ?? "") ||
      !eventKeyOk(eventKey) || !Array.isArray(entries) || entries.length < 1 || entries.length > 20_000)
    return { status: "invalid_snapshot" };
  const seen = new Set();
  for (const row of entries) {
    if (!row || typeof row !== "object" || Array.isArray(row) || !legacyIdOk(row.id) || seen.has(row.id))
      return { status: "legacy_identity_conflict" };
    seen.add(row.id);
    if (!text(row.n, 240) || !validOptionalText(row.s, 80) ||
        ![0, 1].includes(row.t) || ![0, 1].includes(row.nt) || row.t + row.nt > 1 ||
        ![0, 1].includes(row.ru) || row.t === 1 && (row.ru !== 1 || !row.inn) ||
        !innOk(row.inn) || !ogrnOk(row.ogrn) ||
        !validOptionalText(row.country, 80) || legacyCategory(row) === undefined ||
        !validOptionalText(row.b, 2000) || !validOptionalText(row.seg, 120) ||
        legacyMoneyRub(row.rev) === undefined || legacyMoneyRub(row.prof, { allowNegative: true }) === undefined ||
        legacyYear(row.ry) === undefined || legacyYear(row.py) === undefined ||
        url(row.href) === undefined || url(row.w) === undefined)
      return { status: "legacy_record_invalid" };
  }
  const included = entries.map(row => ({ id: row.id, n: row.n, s: row.s, t: row.t, nt: row.nt,
    inn: row.inn, ogrn: row.ogrn, ru: row.ru, rev: row.rev, ry: row.ry, prof: row.prof, py: row.py,
    href: row.href, w: row.w, country: row.country, cat: legacyCategory(row), b: optionalText(row.b, 2000),
    seg: optionalText(row.seg, 120) }));
  const sourceRevision = `legacy-ex-sha256-${sha(JSON.stringify([eventKey, included]))}`;
  const fixtureRef = sourceRevision;
  const companies = entries.map(row => {
    const id = `co-${sha(JSON.stringify([eventKey, row.id])).slice(0, 20)}`;
    const sourceRecordId = `src-${sha(JSON.stringify([eventKey, row.id])).slice(0, 24)}`;
    const revenueRub = legacyMoneyRub(row.rev);
    const profitRub = legacyMoneyRub(row.prof, { allowNegative: true });
    const inn = row.inn || null, ogrn = row.ogrn || null;
    const country = text(row.country, 80) ?? (row.ru === 1 ? "RU" : "unknown");
    const classification = row.t === 1 ? "target" : row.nt === 1 ? "near_target" : "not_target";
    return { id, name: row.n.trim().replace(/\s+/g, " "),
      source: { sourceRecordId, country, booth: optionalText(row.s, 80), href: url(row.href),
        category: legacyCategory(row), description: optionalText(row.b, 2000),
        segment: optionalText(row.seg, 120), duplicateSourceRecordIds: [] },
      enrichment: { status: inn || ogrn || revenueRub !== null || profitRub !== null || url(row.w) ? "found" : "not_found",
        inn, ogrn, revenueRub, revenueYear: legacyYear(row.ry), profitRub, profitYear: legacyYear(row.py),
        activity: "unknown", website: url(row.w),
        provenance: { provider: "legacy-ex-snapshot", fixtureRef } },
      registry: { status: "unknown", provenance: { source: "legacy-ex-snapshot", fixtureRef } },
      qualification: { classification, target: row.t === 1, nearTarget: row.nt === 1,
        reason: "legacy_classification_unverified" } };
  }).sort((a, b) => a.id.localeCompare(b.id));
  return { status: "projected", artifact: { schemaVersion: "1.1.0", exhibitionId: eventKey, sourceRevision, companies } };
}

// V1.2 is additive and leaves the v1.1 projection and its stored contract intact.
// The director originates in the archived exhibition row; tax and employee facts
// require explicit provider and period evidence from an enrichment source.
export function projectLegacyExSnapshotV12({ profileRef, eventKey, entries }) {
  if (!Array.isArray(entries)) return { status: "invalid_snapshot" };
  const isOptionalCount = value => value == null || value === "" || Number.isSafeInteger(value) && value >= 0;
  for (const row of entries) {
    if (!row || typeof row !== "object" || Array.isArray(row) ||
        optionalText(row.dir, 160) === undefined || optionalText(row.dirpos, 160) === undefined ||
        !isOptionalCount(row.taxesPaidRub) || legacyYear(row.taxesPaidYear) === undefined ||
        !isOptionalCount(row.employeeCount) || legacyYear(row.employeeYear) === undefined ||
        ![null, "year_end", "annual_average", "unknown"].includes(row.employeeDefinition ?? null) ||
        (row.taxesPaidRub != null && (!Number.isInteger(row.taxesPaidYear) || typeof row.taxesPaidProvider !== "string" || !row.taxesPaidProvider.trim())) ||
        (row.employeeCount != null && (!Number.isInteger(row.employeeYear) || typeof row.employeeCountProvider !== "string" || !row.employeeCountProvider.trim())))
      return { status: "legacy_record_invalid" };
  }
  const projected = projectLegacyExSnapshotV11({ profileRef, eventKey, entries });
  if (projected.status !== "projected") return projected;
  const facts = entries.map(row => ({ id: row.id, dir: optionalText(row.dir, 160), dirpos: optionalText(row.dirpos, 160),
    taxesPaidRub: row.taxesPaidRub ?? null, taxesPaidYear: legacyYear(row.taxesPaidYear),
    taxesPaidProvider: row.taxesPaidRub == null ? null : row.taxesPaidProvider.trim(),
    employeeCount: row.employeeCount ?? null, employeeYear: legacyYear(row.employeeYear),
    employeeDefinition: row.employeeCount == null ? null : row.employeeDefinition ?? "unknown",
    employeeCountProvider: row.employeeCount == null ? null : row.employeeCountProvider.trim() }));
  const sourceRevision = `legacy-ex-sha256-${sha(JSON.stringify([projected.artifact.sourceRevision, facts]))}`;
  const fixtureRef = sourceRevision;
  const factsByCompanyId = new Map(facts.map(fact =>
    [`co-${sha(JSON.stringify([eventKey, fact.id])).slice(0, 20)}`, fact]));
  for (const company of projected.artifact.companies) {
    const row = factsByCompanyId.get(company.id);
    if (!row) return { status: "legacy_identity_conflict" };
    company.source.director = { name: row.dir, position: row.dirpos,
      provenance: row.dir || row.dirpos ? { provider: "legacy-ex-snapshot", fixtureRef } : null };
    company.enrichment.taxesPaid = { amountRub: row.taxesPaidRub,
      period: row.taxesPaidRub === null ? null : String(row.taxesPaidYear),
      provenance: row.taxesPaidRub === null ? null : { provider: row.taxesPaidProvider, fixtureRef } };
    company.enrichment.employeeCount = { count: row.employeeCount,
      period: row.employeeCount === null ? null : String(row.employeeYear),
      definition: row.employeeCount === null ? null : row.employeeDefinition,
      provenance: row.employeeCount === null ? null : { provider: row.employeeCountProvider, fixtureRef } };
    company.enrichment.provenance.fixtureRef = fixtureRef;
    if (row.taxesPaidRub !== null || row.employeeCount !== null) company.enrichment.status = "found";
  }
  projected.artifact.schemaVersion = "1.2.0";
  projected.artifact.sourceRevision = sourceRevision;
  return projected;
}

export async function importLegacyExSnapshotV11({ repository, profileRef, eventKey, entries }) {
  if (!repository?.saveArtifact) throw new Error("catalog_v11_repository_required");
  const projected = projectLegacyExSnapshotV11({ profileRef, eventKey, entries });
  if (projected.status !== "projected") return { status: projected.status };
  const saved = await repository.saveArtifact({ profileId: profileRef, artifact: projected.artifact });
  return { status: saved.status, exhibitionId: projected.artifact.exhibitionId,
    sourceRevision: projected.artifact.sourceRevision, imported: projected.artifact.companies.length };
}

export async function importLegacyExSnapshotV12({ repository, profileRef, eventKey, entries }) {
  if (!repository?.saveArtifact) throw new Error("catalog_v12_repository_required");
  const projected = projectLegacyExSnapshotV12({ profileRef, eventKey, entries });
  if (projected.status !== "projected") return { status: projected.status };
  const saved = await repository.saveArtifact({ profileId: profileRef, artifact: projected.artifact });
  return { status: saved.status, exhibitionId: projected.artifact.exhibitionId,
    sourceRevision: projected.artifact.sourceRevision, imported: projected.artifact.companies.length };
}
