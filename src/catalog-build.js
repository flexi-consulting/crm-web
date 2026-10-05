import { createHash } from "node:crypto";
import { renderCatalogPreview, catalogPreviewGeneratorRevision } from "./catalog-preview.js";

export const syntheticBuildSources = {
  "demo-expo-001": {
    sourceRevision: "fixture-expo-001-r1",
    records: [
      { sourceRecordId: "src-demo-001", name: "Example Machine Works", country: "RU", booth: "A-01", href: "https://example.invalid/catalog/example-machine-works" },
      { sourceRecordId: "src-demo-002", name: "  EXAMPLE   MACHINE WORKS ", country: "RU", booth: "A-02" },
      { sourceRecordId: "src-demo-003", name: "Synthetic Trade House", country: "RU", booth: "B-03" },
      { sourceRecordId: "src-demo-004", name: "Sample Inactive Manufacturer", country: "RU", booth: "C-04" },
      { sourceRecordId: "src-demo-005", name: "Synthetic Sanctioned Maker", country: "RU", booth: "D-05" }
    ]
  },
  "demo-expo-002": { sourceRevision: "fixture-expo-002-r1", records: [] }
};

const sha = (value, length = 20) => createHash("sha256").update(value).digest("hex").slice(0, length);
const normalizeName = (value) => value.normalize("NFKC").trim().toLocaleLowerCase("en").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
const validId = (value) => typeof value === "string" && /^src-[a-z0-9-]{1,48}$/.test(value);
function safeHttpUrl(value) {
  if (typeof value !== "string" || !value.trim() || /\s/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}
const validRecord = (record) => record && typeof record === "object" && !Array.isArray(record) &&
  validId(record.sourceRecordId) && typeof record.name === "string" && normalizeName(record.name).length > 0 &&
  typeof record.country === "string" && record.country.trim().length > 0 &&
  (record.booth === undefined || record.booth === null || typeof record.booth === "string" && [...record.booth].length <= 80) &&
  (record.href === undefined || record.href === null || safeHttpUrl(record.href) !== null) &&
  Object.keys(record).every((key) => ["sourceRecordId", "name", "country", "booth", "href"].includes(key));
const stableCompanyId = (name) => `co-${sha(normalizeName(name), 20)}`;

export function createSyntheticSourceAdapter({ sources = syntheticBuildSources } = {}) {
  return { async load(exhibitionId) { return structuredClone(sources[exhibitionId]); } };
}

export function createSyntheticEnrichmentAdapter() {
  const values = {
    "src-demo-001": { status: "found", inn: "0000000001", ogrn: "0000000000001", revenueRub: 500000000, activity: "manufacturer", website: "https://example.invalid/machine-works", provenance: { provider: "synthetic-enrichment", fixtureRef: "enrich-001" } },
    "src-demo-003": { status: "unavailable", inn: null, ogrn: null, revenueRub: null, activity: "unknown", website: null, provenance: { provider: "synthetic-enrichment", fixtureRef: "enrich-003-unavailable" } },
    "src-demo-004": { status: "found", inn: "0000000004", ogrn: "0000000000004", revenueRub: 320000000, activity: "manufacturer", website: null, provenance: { provider: "synthetic-enrichment", fixtureRef: "enrich-004" } },
    "src-demo-005": { status: "found", inn: "0000000005", ogrn: "0000000000005", revenueRub: 450000000, activity: "manufacturer", website: null, provenance: { provider: "synthetic-enrichment", fixtureRef: "enrich-005" } }
  };
  return { async enrich(record) { return structuredClone(values[record.sourceRecordId] ?? { status: "not_found", inn: null, ogrn: null, revenueRub: null, activity: "unknown", website: null, provenance: { provider: "synthetic-enrichment", fixtureRef: "enrich-no-match" } }); } };
}

export function createSyntheticRegistryAdapter() {
  const values = {
    "src-demo-001": { status: "ok", source: "synthetic-registry", fixtureRef: "registry-001" },
    "src-demo-003": { status: "unknown", source: "synthetic-registry", fixtureRef: "registry-003-unavailable" },
    "src-demo-004": { status: "inactive", source: "synthetic-registry", fixtureRef: "registry-004" },
    "src-demo-005": { status: "sanctioned", source: "synthetic-registry", fixtureRef: "registry-005" }
  };
  return { async check(record) { return structuredClone(values[record.sourceRecordId] ?? { status: "not_found", source: "synthetic-registry", fixtureRef: "registry-no-match" }); } };
}

export function normalizeEnrichment(value) {
  const allowed = ["found", "not_found", "unavailable"];
  if (!value || !allowed.includes(value.status) || !value.provenance || typeof value.provenance.provider !== "string" || !value.provenance.provider.trim() || typeof value.provenance.fixtureRef !== "string" || !value.provenance.fixtureRef.trim()) return null;
  if (value.status !== "found") {
    return { status: value.status, inn: null, ogrn: null, revenueRub: null, activity: "unknown", website: null, provenance: { provider: value.provenance.provider.trim(), fixtureRef: value.provenance.fixtureRef.trim() } };
  }
  if ((value.inn != null && (typeof value.inn !== "string" || !/^\d{10,12}$/.test(value.inn))) ||
      (value.ogrn != null && (typeof value.ogrn !== "string" || !/^\d{13,15}$/.test(value.ogrn))) ||
      (value.revenueRub != null && (!Number.isSafeInteger(value.revenueRub) || value.revenueRub < 0)) ||
      (value.activity != null && !["manufacturer", "distributor", "service", "unknown"].includes(value.activity)) ||
      (value.website != null && safeHttpUrl(value.website) === null)) return null;
  const inn = typeof value.inn === "string" && /^\d{10,12}$/.test(value.inn) ? value.inn : null;
  const ogrn = typeof value.ogrn === "string" && /^\d{13,15}$/.test(value.ogrn) ? value.ogrn : null;
  const revenueRub = Number.isSafeInteger(value.revenueRub) && value.revenueRub >= 0 ? value.revenueRub : null;
  const activity = ["manufacturer", "distributor", "service", "unknown"].includes(value.activity) ? value.activity : "unknown";
  const website = value.website == null ? null : safeHttpUrl(value.website);
  return { status: value.status, inn, ogrn, revenueRub, activity, website, provenance: { provider: value.provenance.provider.trim(), fixtureRef: value.provenance.fixtureRef.trim() } };
}

export function normalizeRegistry(value) {
  if (!value || !["ok", "sanctioned", "not_found", "inactive", "unknown"].includes(value.status) || typeof value.source !== "string" || !value.source.trim() || typeof value.fixtureRef !== "string" || !value.fixtureRef.trim()) return null;
  return { status: value.status, provenance: { source: value.source.trim(), fixtureRef: value.fixtureRef.trim() } };
}

export function qualify(company) {
  const { enrichment: e, registry: r, source } = company;
  if (source.country !== "RU" || e.activity === "distributor" || e.activity === "service" || r.status === "sanctioned") {
    return { classification: "not_target", target: false, nearTarget: false, reason: r.status === "sanctioned" ? "registry_sanctioned" : "not_eligible_by_country_or_activity" };
  }
  if (e.status === "found" && e.inn && e.activity === "manufacturer" && e.revenueRub !== null && e.revenueRub >= 150_000_000 && e.revenueRub <= 1_000_000_000 && r.status === "ok") {
    return { classification: "target", target: true, nearTarget: false, reason: "manufacturer_revenue_and_registry_eligible" };
  }
  return { classification: "near_target", target: false, nearTarget: true, reason: !e.inn ? "inn_missing" : e.revenueRub === null ? "revenue_unknown" : r.status === "unknown" ? "registry_unknown" : r.status === "inactive" || r.status === "not_found" ? "registry_not_active" : e.activity === "unknown" ? "activity_unknown" : "outside_target_threshold" };
}

export function validateReport(artifact, report) {
  const rows = artifact.companies;
  const counts = {
    sourceRecords: report.stages.source.imported,
    uniqueCompanies: rows.length,
    duplicateRecords: report.stages.dedup.removed,
    enrichmentFound: rows.filter((x) => x.enrichment.status === "found").length,
    enrichmentNotFound: rows.filter((x) => x.enrichment.status === "not_found").length,
    enrichmentUnavailable: rows.filter((x) => x.enrichment.status === "unavailable").length,
    registryOk: rows.filter((x) => x.registry.status === "ok").length,
    registryUnknown: rows.filter((x) => x.registry.status === "unknown").length,
    registrySanctioned: rows.filter((x) => x.registry.status === "sanctioned").length,
    registryNotFound: rows.filter((x) => x.registry.status === "not_found").length,
    registryInactive: rows.filter((x) => x.registry.status === "inactive").length,
    targets: rows.filter((x) => x.qualification.target).length,
    nearTargets: rows.filter((x) => x.qualification.nearTarget).length,
    notTargets: rows.filter((x) => x.qualification.classification === "not_target").length
  };
  const ids = rows.map((x) => x.id);
  const issues = [];
  if (ids.some((id) => !/^co-[a-f0-9]{20}$/.test(id)) || new Set(ids).size !== ids.length) issues.push({ code: "unsafe_or_duplicate_company_id" });
  if (counts.targets + counts.nearTargets + counts.notTargets !== rows.length) issues.push({ code: "qualification_counts_mismatch" });
  if (counts.sourceRecords !== counts.uniqueCompanies + counts.duplicateRecords) issues.push({ code: "source_counts_mismatch" });
  if (counts.enrichmentFound + counts.enrichmentNotFound + counts.enrichmentUnavailable !== rows.length) issues.push({ code: "enrichment_counts_mismatch" });
  if (counts.registryOk + counts.registryUnknown + counts.registrySanctioned + counts.registryNotFound + counts.registryInactive !== rows.length) issues.push({ code: "registry_counts_mismatch" });
  return { valid: issues.length === 0, issues, counts };
}

export function createCatalogBuildService({ sourceAdapter = createSyntheticSourceAdapter(), enrichmentAdapter = createSyntheticEnrichmentAdapter(), registryAdapter = createSyntheticRegistryAdapter(), sources = syntheticBuildSources } = {}) {
  const builds = new Map();
  const byKey = new Map();
  const running = new Map();
  const previews = new Map();

  async function build({ profileId, idempotencyKey, exhibitionId }) {
    const existingId = byKey.get(`${profileId}\0${idempotencyKey}`);
    if (existingId) {
      const existing = builds.get(existingId);
      if (existing.artifact.exhibitionId !== exhibitionId) return { status: 409, body: { error: "idempotency_conflict", code: "BUILD_IDEMPOTENCY_CONFLICT" } };
      return { status: 200, body: { ...existing, replayed: true } };
    }
    // Reject a missing fixture before calling any injected adapter.
    if (!Object.hasOwn(sources, exhibitionId)) return { status: 404, body: { error: "synthetic_source_not_found", code: "BUILD_SOURCE_MISSING" } };
    const key = `${profileId}\0${idempotencyKey}`;
    if (running.has(key)) {
      const inFlightResult = await running.get(key);
      return inFlightResult.status === 201
        ? { status: 200, body: { ...inFlightResult.body, replayed: true } }
        : inFlightResult;
    }
    const task = (async () => {
      let source;
      try { source = await sourceAdapter.load(exhibitionId); }
      catch { return { status: 503, body: { error: "source_unavailable", code: "BUILD_SOURCE_UNAVAILABLE" } }; }
      if (!source || typeof source.sourceRevision !== "string" || !Array.isArray(source.records) || source.records.length === 0) {
        return { status: 422, body: { error: "source_prerequisite_missing", code: "BUILD_SOURCE_INVALID" } };
      }
      const seenIds = new Set();
      for (const record of source.records) {
        if (!validRecord(record)) return { status: 422, body: { error: "source_record_invalid", code: "BUILD_SOURCE_INVALID" } };
        if (seenIds.has(record.sourceRecordId)) return { status: 422, body: { error: "duplicate_source_record_id", code: "BUILD_DUPLICATE_SOURCE_ID" } };
        seenIds.add(record.sourceRecordId);
      }
      const imported = source.records.map((record) => ({ ...structuredClone(record), normalizedName: normalizeName(record.name) }));
      const unique = new Map();
      const duplicateRecords = [];
      for (const record of imported) {
        const prev = unique.get(record.normalizedName);
        if (prev) { prev.duplicateSourceRecordIds.push(record.sourceRecordId); duplicateRecords.push(record.sourceRecordId); }
        else unique.set(record.normalizedName, { ...record, duplicateSourceRecordIds: [] });
      }
      const companies = [];
      const providerErrors = [];
      for (const record of unique.values()) {
        let enrichment;
        try { enrichment = normalizeEnrichment(await enrichmentAdapter.enrich(record)); }
        catch { enrichment = null; }
        if (!enrichment) {
          enrichment = { status: "unavailable", inn: null, ogrn: null, revenueRub: null, activity: "unknown", website: null, provenance: { provider: "synthetic-adapter", fixtureRef: "provider-unavailable" } };
          providerErrors.push({ stage: "enrichment", sourceRecordId: record.sourceRecordId, code: "ENRICHMENT_UNAVAILABLE" });
        }
        let registry;
        if (!enrichment.inn && !enrichment.ogrn) {
          registry = { status: "unknown", provenance: { source: "synthetic-pipeline", fixtureRef: "registry_skipped_identity_missing" } };
        } else {
          try { registry = normalizeRegistry(await registryAdapter.check({ ...record, enrichment })); }
          catch { registry = null; }
        }
        if (!registry) {
          registry = { status: "unknown", provenance: { source: "synthetic-adapter", fixtureRef: "provider-unavailable" } };
          providerErrors.push({ stage: "registry", sourceRecordId: record.sourceRecordId, code: "REGISTRY_UNAVAILABLE" });
        }
        const company = {
          id: stableCompanyId(record.normalizedName), name: record.name.trim().replace(/\s+/g, " "), source: { sourceRecordId: record.sourceRecordId, country: record.country, booth: record.booth ?? null, href: record.href == null ? null : safeHttpUrl(record.href), duplicateSourceRecordIds: record.duplicateSourceRecordIds },
          enrichment, registry
        };
        company.qualification = qualify(company);
        companies.push(company);
      }
      companies.sort((a, b) => a.id.localeCompare(b.id));
      const artifact = { schemaVersion: "1.0.0", exhibitionId, sourceRevision: source.sourceRevision, companies };
      const report = {
        schemaVersion: "1.0.0", exhibitionId, sourceRevision: source.sourceRevision,
        stages: { source: { status: "complete", imported: imported.length }, dedup: { status: "complete", removed: duplicateRecords.length }, enrichment: { status: companies.some((x) => x.enrichment.status === "unavailable") ? "partial" : "complete" }, registry: { status: companies.some((x) => x.registry.status === "unknown") ? "partial" : "complete" }, qualification: { status: "complete" }, artifact: { status: "complete" } },
        providerErrors, validation: null
      };
      report.validation = validateReport(artifact, report);
      if (!report.validation.valid) return { status: 422, body: { error: "build_validation_failed", code: "BUILD_VALIDATION_FAILED", report } };
      const buildId = `build-${sha(`${profileId}\0${idempotencyKey}`, 24)}`;
      const result = { buildId, artifact, report, replayed: false };
      builds.set(buildId, { profileId, ...result });
      byKey.set(key, buildId);
      return { status: 201, body: result };
    })();
    running.set(key, task);
    try { return await task; } finally { running.delete(key); }
  }

  function get({ profileId, buildId }) {
    const build = builds.get(buildId);
    if (!build || build.profileId !== profileId) return { status: 404, body: { error: "catalog_build_not_found", code: "BUILD_NOT_FOUND" } };
    const { profileId: _profileId, ...body } = build;
    return { status: 200, body };
  }
  function readParticipants({ profileId, buildId, companyId = null, query = "", classification = null }) {
    const owned = get({ profileId, buildId });
    if (owned.status !== 200) return owned;
    const { artifact, report } = owned.body;
    if (report.validation?.valid !== true) return { status: 409, body: { error: "validated_build_required", code: "BUILD_NOT_VALIDATED" } };
    const normalizedQuery = query.trim().toLocaleLowerCase("en");
    const matches = artifact.companies.filter((company) =>
      (companyId === null || company.id === companyId) &&
      (classification === null || company.qualification.classification === classification) &&
      (!normalizedQuery || `${company.name} ${company.source.country} ${company.source.booth ?? ""}`.toLocaleLowerCase("en").includes(normalizedQuery)));
    if (companyId !== null && matches.length === 0) return { status: 404, body: { error: "participant_not_found", code: "BUILD_PARTICIPANT_NOT_FOUND" } };
    return { status: 200, body: {
      domainApiVersion: "1.0.0", buildId, exhibitionId: artifact.exhibitionId,
      sourceRevision: artifact.sourceRevision, items: structuredClone(matches).map((company) => ({
        ...company, detailPath: `/api/v1/catalog-builds/${buildId}/participants/${company.id}`
      }))
    } };
  }
  function preview({ profileId, buildId }) {
    const sourceBuild = builds.get(buildId);
    if (!sourceBuild || sourceBuild.profileId !== profileId) return { status: 404, body: { error: "catalog_build_not_found", code: "BUILD_NOT_FOUND" } };
    if (sourceBuild.report.validation?.valid !== true) return { status: 409, body: { error: "validated_build_required", code: "BUILD_NOT_VALIDATED" } };
    const generated = renderCatalogPreview({ buildId, artifact: sourceBuild.artifact, buildReport: sourceBuild.report });
    if (!generated.valid) return { status: 422, body: { error: "preview_validation_failed", code: "PREVIEW_VALIDATION_FAILED", report: generated.report } };
    const previewId = `preview-${sha(`${buildId}\0${catalogPreviewGeneratorRevision}`, 24)}`;
    if (previews.has(previewId)) return { status: 200, body: { ...previews.get(previewId).descriptor, replayed: true } };
    const record = {
      profileId,
      html: generated.html,
      descriptor: {
        previewId, buildId, sourceRevision: sourceBuild.artifact.sourceRevision,
        generatorRevision: catalogPreviewGeneratorRevision,
        url: `/api/v1/catalog-previews/${previewId}`,
        report: generated.report,
        published: false,
        replayed: false
      }
    };
    previews.set(previewId, record);
    return { status: 201, body: record.descriptor };
  }
  function getPreview({ profileId, previewId }) {
    const preview = previews.get(previewId);
    if (!preview || preview.profileId !== profileId) return { status: 404, body: { error: "catalog_preview_not_found", code: "PREVIEW_NOT_FOUND" } };
    return { status: 200, html: preview.html, descriptor: preview.descriptor };
  }
  return { build, get, readParticipants, preview, getPreview };
}
