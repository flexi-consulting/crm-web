import { createHash } from "node:crypto";

const classifications = new Set(["target", "near_target", "not_target", "unknown"]);
const revenueBands = new Set(["0-100", "100-1500", "1500+"]);
const profitBands = new Set(["loss", "0-30", "30-200", "200+"]);
const fold = value => String(value ?? "").normalize("NFKC").toLocaleLowerCase("ru").trim();

function matchesBand(value, band, kind) {
  if (band === null) return true;
  if (!Number.isSafeInteger(value)) return false;
  if (kind === "revenue") return band === "0-100" ? value < 100_000_000 :
    band === "100-1500" ? value >= 100_000_000 && value <= 1_500_000_000 : value > 1_500_000_000;
  return band === "loss" ? value < 0 : band === "0-30" ? value >= 0 && value < 30_000_000 :
    band === "30-200" ? value >= 30_000_000 && value < 200_000_000 : value >= 200_000_000;
}

export function queryCatalogV11(artifact, { query = "", classification = null, country = null,
  revenueBand = null, profitBand = null } = {}) {
  if (!new Set(["1.1.0", "1.2.0"]).has(artifact?.schemaVersion) || !Array.isArray(artifact.companies) ||
      typeof query !== "string" || query.length > 120 ||
      classification !== null && !classifications.has(classification) ||
      country !== null && (typeof country !== "string" || country.length > 80) ||
      revenueBand !== null && !revenueBands.has(revenueBand) ||
      profitBand !== null && !profitBands.has(profitBand))
    return { status: "invalid_query" };
  const needle = fold(query), normalizedCountry = country === null ? null : fold(country);
  const items = artifact.companies.filter(company => {
    const source = company.source ?? {}, enrichment = company.enrichment ?? {};
    const searchable = fold([company.name, source.category, source.country].filter(Boolean).join(" "));
    return (classification === null || company.qualification?.classification === classification) &&
      (normalizedCountry === null || fold(source.country) === normalizedCountry) &&
      matchesBand(enrichment.revenueRub, revenueBand, "revenue") &&
      matchesBand(enrichment.profitRub, profitBand, "profit") && (!needle || searchable.includes(needle));
  });
  return { status: "ok", total: items.length, items: structuredClone(items) };
}

const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[char]);
const moneyLabel = value => value === null ? "Неизвестно" : `${(value / 1_000_000).toLocaleString("ru-RU")} млн ₽`;
function safeSourceUrl(value) {
  if (typeof value !== "string" || /[\s\u0000-\u001f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.hostname && !url.username && !url.password
      ? url.href : null;
  } catch { return null; }
}

export function renderCatalogV11({ artifact, result, filters = {}, participantCompanyIds = [],
  participantBuildId = null, telegramBotUsername = null }) {
  if (!new Set(["1.1.0", "1.2.0"]).has(artifact?.schemaVersion) || result?.status !== "ok" || !Array.isArray(result.items))
    return { status: "invalid_catalog_view", html: "" };
  const participantLinks = new Set(Array.isArray(participantCompanyIds)
    ? participantCompanyIds.filter(id => /^co-[a-f0-9]{20}$/.test(id)) : []);
  const telegramUsername = typeof telegramBotUsername === "string" && /^[A-Za-z0-9_]{5,32}$/.test(telegramBotUsername)
    ? telegramBotUsername : null;
  const telegramDealLink = companyId => {
    if (!telegramUsername || !/^build-[a-f0-9]{24}$/.test(participantBuildId ?? "") ||
        !participantLinks.has(companyId)) return "";
    const payload = `crm1_${participantBuildId}_${companyId}`;
    if (payload.length > 64) return "";
    return `<a href="https://t.me/${telegramUsername}?start=${payload}" rel="noopener noreferrer">Подготовить сделку в CRM Telegram</a>`;
  };
  const options = (name, values, selected, labels = {}) => `<label>${name}<select name="${name}"><option value="">Все</option>${values.map(value =>
    `<option value="${escapeHtml(value)}"${selected === value ? " selected" : ""}>${escapeHtml(labels[value] ?? value)}</option>`).join("")}</select></label>`;
  const countries = [...new Set(artifact.companies.map(company => company.source?.country).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, "ru"));
  const cards = result.items.map(company => {
    const source = company.source, enrichment = company.enrichment;
    const safeHref = safeSourceUrl(source.href);
    return `<article class="company-card" data-company-id="${escapeHtml(company.id)}"><h2>${escapeHtml(company.name)}</h2>
      <p>${escapeHtml(source.country)}${source.booth ? ` · Стенд: ${escapeHtml(source.booth)}` : ""}${source.category ? ` · ${escapeHtml(source.category)}` : ""}</p>
      ${source.description ? `<p>${escapeHtml(source.description)}</p>` : ""}
      <p>Выручка: ${escapeHtml(moneyLabel(enrichment.revenueRub))}${enrichment.revenueYear ? ` (${enrichment.revenueYear})` : ""}</p>
      <p>Прибыль: ${escapeHtml(moneyLabel(enrichment.profitRub))}${enrichment.profitYear ? ` (${enrichment.profitYear})` : ""}</p>
      ${artifact.schemaVersion === "1.2.0" ? `<p>Уплаченные налоги: ${escapeHtml(moneyLabel(enrichment.taxesPaid?.amountRub ?? null))}${enrichment.taxesPaid?.period ? ` (${escapeHtml(enrichment.taxesPaid.period)})` : ""}</p>
      <p>Сотрудники: ${enrichment.employeeCount?.count == null ? "Неизвестно" : escapeHtml(enrichment.employeeCount.count)}${enrichment.employeeCount?.period ? ` (${escapeHtml(enrichment.employeeCount.period)})` : ""}</p>
      <p>Директор: ${source.director?.name ? escapeHtml(source.director.name) : "Неизвестно"}${source.director?.position ? ` · ${escapeHtml(source.director.position)}` : ""}</p>` : ""}
      ${participantLinks.has(company.id) ? `<p><a href="/catalogs/${encodeURIComponent(artifact.exhibitionId)}/participants/${encodeURIComponent(company.id)}">Карточка CRM и подготовка сделки</a></p>` : ""}
      ${telegramDealLink(company.id)}
      ${safeHref ? `<a href="${escapeHtml(safeHref)}" rel="noopener noreferrer">Профиль выставки</a>` : ""}</article>`;
  }).join("");
  const html = `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>Каталог ${escapeHtml(artifact.exhibitionId)}</title><main>
    <h1>Каталог выставки ${escapeHtml(artifact.exhibitionId)}</h1><form method="get"><label>Поиск<input name="query" value="${escapeHtml(filters.query ?? "")}"></label>
    ${options("country", countries, filters.country)}${options("classification", [...classifications], filters.classification, { target: "Целевая", near_target: "Почти целевая", not_target: "Не целевая", unknown: "Не подтверждена" })}
    ${options("revenueBand", [...revenueBands], filters.revenueBand)}${options("profitBand", [...profitBands], filters.profitBand)}
    <button type="submit">Показать</button></form><p>Найдено: ${result.total}</p>${cards || "<p>Ничего не найдено.</p>"}</main></html>`;
  return { status: "ok", html };
}

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: {
  "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store",
  "x-content-type-options": "nosniff"
} });

export function createCatalogV11ReadHandler({ repository, resolveTrustedProfile, resolveParticipantCompanyIds,
  telegramBotUsername = null }) {
  if (typeof repository?.getArtifact !== "function" || typeof resolveTrustedProfile !== "function")
    throw new TypeError("catalog v1.1 repository and trusted profile resolver required");
  return async function handle(request) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/catalogs\/([a-z0-9][a-z0-9-]{0,79})$/);
    if (!match || request.method !== "GET") return reply(404, { error: "not_found" });
    let context;
    try { context = await resolveTrustedProfile(request); } catch {
      return reply(503, { error: "trusted_profile_unavailable" });
    }
    if (!context || typeof context.profileId !== "string" || !context.profileId || !Array.isArray(context.scopes))
      return reply(503, { error: "trusted_profile_unavailable" });
    if (!context.scopes.includes("crm.catalog.read")) return reply(403, { error: "required_scope_missing" });
    const params = [...url.searchParams.keys()];
    if (params.some(key => !["query", "classification", "country", "revenueBand", "profitBand"].includes(key)) ||
        params.some(key => url.searchParams.getAll(key).length !== 1))
      return reply(400, { error: "invalid_query" });
    const filters = { query: url.searchParams.get("query") ?? "",
      classification: url.searchParams.get("classification") || null,
      country: url.searchParams.has("country") ? url.searchParams.get("country") : null,
      revenueBand: url.searchParams.get("revenueBand") || null,
      profitBand: url.searchParams.get("profitBand") || null };
    let artifact;
    try { artifact = await repository.getArtifact({ profileId: context.profileId, exhibitionId: match[1] }); }
    catch { return reply(503, { error: "catalog_unavailable" }); }
    if (!artifact) return reply(404, { error: "catalog_not_found" });
    const result = queryCatalogV11(artifact, filters);
    if (result.status !== "ok") return reply(400, { error: "invalid_query" });
    let participantCompanyIds = [], participantBuildId = null;
    if (typeof resolveParticipantCompanyIds === "function") {
      try {
        const resolved = await resolveParticipantCompanyIds({ profileId: context.profileId, eventKey: match[1] });
        if (resolved?.status === "ok" && Array.isArray(resolved.companyIds)) {
          participantCompanyIds = resolved.companyIds;
          participantBuildId = resolved.buildId ?? null;
        }
      } catch { /* Catalog reads stay available while an optional action binding is unavailable. */ }
    }
    const view = renderCatalogV11({ artifact, result, filters, participantCompanyIds, participantBuildId, telegramBotUsername });
    if (view.status !== "ok") return reply(503, { error: "catalog_unavailable" });
    return new Response(view.html, { status: 200, headers: {
      "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store",
      "x-content-type-options": "nosniff", "referrer-policy": "same-origin",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
    } });
  };
}

export function createCatalogV11ParticipantLinkHandler({ repository, resolveTrustedProfile,
  resolveLegacyParticipant }) {
  if (typeof repository?.getArtifact !== "function" || typeof resolveTrustedProfile !== "function" ||
      typeof resolveLegacyParticipant !== "function")
    throw new TypeError("catalog v1.1 participant-link dependencies required");
  return async function handle(request) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/catalogs\/([a-z0-9][a-z0-9-]{0,79})\/participants\/(co-[a-f0-9]{20})$/);
    if (!match || request.method !== "GET") return reply(404, { error: "not_found" });
    if (url.searchParams.size) return reply(400, { error: "invalid_query" });
    let context;
    try { context = await resolveTrustedProfile(request); } catch {
      return reply(503, { error: "trusted_profile_unavailable" });
    }
    if (!context || typeof context.profileId !== "string" || !context.profileId || !Array.isArray(context.scopes))
      return reply(503, { error: "trusted_profile_unavailable" });
    if (!context.scopes.includes("crm.catalog.read")) return reply(403, { error: "required_scope_missing" });
    let artifact, participant;
    try {
      artifact = await repository.getArtifact({ profileId: context.profileId, exhibitionId: match[1] });
      if (!artifact || !artifact.companies.some(company => company.id === match[2]))
        return reply(404, { error: "catalog_participant_not_found" });
      participant = await resolveLegacyParticipant({ profileId: context.profileId,
        eventKey: match[1], companyId: match[2] });
    } catch { return reply(503, { error: "catalog_participant_unavailable" }); }
    if (participant?.status !== 200 || participant.body?.companyId !== match[2] ||
        !/^build-[a-f0-9]{24}$/.test(participant.body?.buildId ?? ""))
      return reply(participant?.status === 404 ? 404 : 503, { error: "catalog_participant_unavailable" });
    if (artifact.schemaVersion === "1.2.0") {
      const company = artifact.companies.find(item => item.id === match[2]);
      const enrichment = company.enrichment, director = company.source.director;
      const html = `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(company.name)}</title><main>
        <h1>${escapeHtml(company.name)}</h1><p>${escapeHtml(company.source.country)}${company.source.booth ? ` · Стенд: ${escapeHtml(company.source.booth)}` : ""}</p>
        <p>Уплаченные налоги: ${escapeHtml(moneyLabel(enrichment.taxesPaid.amountRub))}${enrichment.taxesPaid.period ? ` (${escapeHtml(enrichment.taxesPaid.period)})` : ""}</p>
        <p>Сотрудники: ${enrichment.employeeCount.count === null ? "Неизвестно" : escapeHtml(enrichment.employeeCount.count)}${enrichment.employeeCount.period ? ` (${escapeHtml(enrichment.employeeCount.period)})` : ""}</p>
        <p>Директор: ${director.name ? escapeHtml(director.name) : "Неизвестно"}${director.position ? ` · ${escapeHtml(director.position)}` : ""}</p>
        <p><a href="/catalogs/${encodeURIComponent(participant.body.buildId)}/participants/${encodeURIComponent(match[2])}">Карточка CRM и подготовка сделки</a></p></main></html>`;
      return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8",
        "cache-control": "private, no-store", "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'" } });
    }
    return new Response(null, { status: 303, headers: { location: `/catalogs/${participant.body.buildId}/participants/${match[2]}`,
      "cache-control": "private, no-store", "referrer-policy": "same-origin", "x-content-type-options": "nosniff" } });
  };
}

const searchError = (status, error) => new Response(JSON.stringify({ error }), { status, headers: {
  "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store",
  "x-content-type-options": "nosniff"
} });

function clientCatalogItem(company, schemaVersion = "1.1.0") {
  const source = company.source ?? {};
  const enrichment = company.enrichment ?? {};
  const enriched = enrichment.status === "found";
  const item = {
    id: company.id,
    name: company.name,
    country: source.country,
    booth: source.booth ?? null,
    category: source.category ?? null,
    description: source.description ?? null,
    segment: source.segment ?? null,
    revenueRub: enriched ? enrichment.revenueRub : null,
    revenueYear: enriched ? enrichment.revenueYear : null,
    profitRub: enriched ? enrichment.profitRub : null,
    profitYear: enriched ? enrichment.profitYear : null,
    activity: enriched ? enrichment.activity : "unknown",
    website: enriched ? enrichment.website : null,
    classification: company.qualification?.classification ?? "unknown"
  };
  if (schemaVersion === "1.2.0") Object.assign(item, {
    taxesPaidRub: enriched ? enrichment.taxesPaid.amountRub : null,
    taxesPaidPeriod: enriched ? enrichment.taxesPaid.period : null,
    taxesPaidProvenance: enriched ? enrichment.taxesPaid.provenance : null,
    employeeCount: enriched ? enrichment.employeeCount.count : null,
    employeePeriod: enriched ? enrichment.employeeCount.period : null,
    employeeDefinition: enriched ? enrichment.employeeCount.definition : null,
    employeeProvenance: enriched ? enrichment.employeeCount.provenance : null,
    directorName: source.director.name,
    directorPosition: source.director.position,
    directorProvenance: source.director.provenance
  });
  return item;
}

// Structured app-owned read for the Agent capability. The browser page and
// Agent search share queryCatalogV11; the projection excludes registry internals,
// tax identifiers and duplicate source IDs while retaining provenance for the
// additive public-business-facts contract.
export function createCatalogV11SearchHandler({ repository, resolveTrustedProfile }) {
  if (typeof repository?.getArtifact !== "function" || typeof resolveTrustedProfile !== "function")
    throw new TypeError("catalog v1.1 repository and trusted profile resolver required");
  return async function handle(request) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/v1\/catalogs\/([a-z0-9][a-z0-9-]{0,79})\/entries$/);
    if (!match || request.method !== "GET") return searchError(404, "not_found");
    let context;
    try { context = await resolveTrustedProfile(request); } catch {
      return searchError(503, "trusted_profile_unavailable");
    }
    if (!context || typeof context.profileId !== "string" || !context.profileId || !Array.isArray(context.scopes))
      return searchError(503, "trusted_profile_unavailable");
    if (!context.scopes.includes("crm.catalog.read")) return searchError(403, "required_scope_missing");

    const allowed = ["query", "classification", "country", "revenueBand", "profitBand", "limit", "offset"];
    const keys = [...url.searchParams.keys()];
    if (keys.some(key => !allowed.includes(key)) || keys.some(key => url.searchParams.getAll(key).length !== 1))
      return searchError(400, "invalid_query");
    const limitText = url.searchParams.get("limit");
    const offsetText = url.searchParams.get("offset");
    const limit = limitText === null ? 25 : /^(?:[1-9]|[1-9][0-9]|100)$/.test(limitText) ? Number(limitText) : null;
    const offset = offsetText === null ? 0 : /^(?:0|[1-9][0-9]{0,4})$/.test(offsetText) ? Number(offsetText) : null;
    if (limit === null || offset === null || offset > 20_000) return searchError(400, "invalid_query");
    const filters = { query: url.searchParams.get("query") ?? "",
      classification: url.searchParams.get("classification") || null,
      country: url.searchParams.has("country") ? url.searchParams.get("country") : null,
      revenueBand: url.searchParams.get("revenueBand") || null,
      profitBand: url.searchParams.get("profitBand") || null };
    let artifact;
    try { artifact = await repository.getArtifact({ profileId: context.profileId, exhibitionId: match[1] }); }
    catch { return searchError(503, "catalog_unavailable"); }
    if (!artifact) return searchError(404, "catalog_not_found");
    const result = queryCatalogV11(artifact, filters);
    if (result.status !== "ok") return searchError(400, "invalid_query");
    return new Response(JSON.stringify({ domainApiVersion: artifact.schemaVersion === "1.2.0" ? "1.1.0" : "1.0.0",
      artifactVersion: artifact.schemaVersion,
      exhibitionId: artifact.exhibitionId, sourceRevision: artifact.sourceRevision, total: result.total,
      limit, offset, items: result.items.slice(offset, offset + limit)
        .map(company => clientCatalogItem(company, artifact.schemaVersion)) }), { status: 200, headers: {
      "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store",
      "x-content-type-options": "nosniff"
    } });
  };
}

export const createCatalogV12CompatibleSearchHandler = createCatalogV11SearchHandler;

const sha256 = value => createHash("sha256").update(value).digest("hex");
const profileRefOk = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const validYear = value => value === null || Number.isInteger(value) && value >= 1900 && value <= 2200;
function validV11Artifact(artifact) {
  if (!exactKeys(artifact, ["schemaVersion", "exhibitionId", "sourceRevision", "companies"]) ||
      artifact.schemaVersion !== "1.1.0" || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(artifact.exhibitionId ?? "") ||
      typeof artifact.sourceRevision !== "string" || !artifact.sourceRevision ||
      !Array.isArray(artifact.companies) || artifact.companies.length > 20_000) return false;
  return artifact.companies.every(company => {
    if (!exactKeys(company, ["id", "name", "source", "enrichment", "registry", "qualification"]) ||
        !/^co-[a-f0-9]{20}$/.test(company.id ?? "") || typeof company.name !== "string" || !company.name.trim()) return false;
    const source = company.source, enrichment = company.enrichment, registry = company.registry, qualification = company.qualification;
    if (!exactKeys(source, ["sourceRecordId", "country", "booth", "href", "category", "description", "segment", "duplicateSourceRecordIds"]) ||
        !/^src-[a-z0-9-]{1,48}$/.test(source.sourceRecordId ?? "") || typeof source.country !== "string" || !source.country.trim() ||
        !(source.booth === null || typeof source.booth === "string" && source.booth.length <= 80) ||
        !(source.href === null || safeSourceUrl(source.href) === source.href) ||
        !(source.category === null || typeof source.category === "string" && source.category.length <= 240) ||
        !(source.description === null || typeof source.description === "string" && source.description.length <= 2000) ||
        !(source.segment === null || typeof source.segment === "string" && source.segment.length <= 120) ||
        !Array.isArray(source.duplicateSourceRecordIds) || source.duplicateSourceRecordIds.some(id => !/^src-[a-z0-9-]{1,48}$/.test(id))) return false;
    if (!exactKeys(enrichment, ["status", "inn", "ogrn", "revenueRub", "revenueYear", "profitRub", "profitYear", "activity", "website", "provenance"]) ||
        !["found", "not_found", "unavailable"].includes(enrichment.status) ||
        !(enrichment.inn === null || /^([0-9]{10}|[0-9]{12})$/.test(enrichment.inn)) ||
        !(enrichment.ogrn === null || /^([0-9]{13}|[0-9]{15})$/.test(enrichment.ogrn)) ||
        !(enrichment.revenueRub === null || Number.isSafeInteger(enrichment.revenueRub) && enrichment.revenueRub >= 0) ||
        !validYear(enrichment.revenueYear) ||
        !(enrichment.profitRub === null || Number.isSafeInteger(enrichment.profitRub)) || !validYear(enrichment.profitYear) ||
        !["manufacturer", "distributor", "service", "unknown"].includes(enrichment.activity) ||
        !(enrichment.website === null || safeSourceUrl(enrichment.website) === enrichment.website) ||
        !exactKeys(enrichment.provenance, ["provider", "fixtureRef"]) ||
        ![enrichment.provenance.provider, enrichment.provenance.fixtureRef].every(value => typeof value === "string" && value.trim())) return false;
    if (!exactKeys(registry, ["status", "provenance"]) || !["ok", "sanctioned", "not_found", "inactive", "unknown"].includes(registry.status) ||
        !exactKeys(registry.provenance, ["source", "fixtureRef"]) ||
        ![registry.provenance.source, registry.provenance.fixtureRef].every(value => typeof value === "string" && value.trim())) return false;
    return exactKeys(qualification, ["classification", "target", "nearTarget", "reason"]) &&
      ["target", "near_target", "not_target", "unknown"].includes(qualification.classification) &&
      typeof qualification.target === "boolean" && typeof qualification.nearTarget === "boolean" &&
      typeof qualification.reason === "string";
  }) && new Set(artifact.companies.map(company => company.id)).size === artifact.companies.length;
}

export function createCatalogV11D1Repository(db, now = () => new Date().toISOString()) {
  if (!db?.prepare || typeof now !== "function") throw new TypeError("catalog v1.1 D1 binding required");
  async function saveArtifact({ profileId, artifact }) {
    if (!profileRefOk(profileId) || !validV11Artifact(artifact))
      return { status: "invalid_artifact" };
    const artifactJson = JSON.stringify(artifact), contentSha = sha256(artifactJson), updatedAt = now();
    try {
      const prior = await db.prepare(`SELECT content_sha FROM crm_catalog_v11_artifacts
        WHERE profile_ref=? AND exhibition_id=?`).bind(profileId, artifact.exhibitionId).first();
      if (prior?.content_sha === contentSha) return { status: "replay", exhibitionId: artifact.exhibitionId,
        sourceRevision: artifact.sourceRevision };
      await db.prepare(`INSERT INTO crm_catalog_v11_artifacts
        (profile_ref,exhibition_id,source_revision,artifact_json,content_sha,updated_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT(profile_ref,exhibition_id) DO UPDATE SET
        source_revision=excluded.source_revision,artifact_json=excluded.artifact_json,
        content_sha=excluded.content_sha,updated_at=excluded.updated_at`)
        .bind(profileId, artifact.exhibitionId, artifact.sourceRevision, artifactJson, contentSha, updatedAt).run();
      return { status: "stored", exhibitionId: artifact.exhibitionId, sourceRevision: artifact.sourceRevision };
    } catch { return { status: "storage_unavailable" }; }
  }
  async function getArtifact({ profileId, exhibitionId }) {
    if (!profileRefOk(profileId) || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(exhibitionId ?? "")) return null;
    const row = await db.prepare(`SELECT artifact_json,content_sha FROM crm_catalog_v11_artifacts
      WHERE profile_ref=? AND exhibition_id=?`).bind(profileId, exhibitionId).first();
    if (!row) return null;
    if (sha256(row.artifact_json) !== row.content_sha) throw new Error("stored catalog integrity check failed");
    const artifact = JSON.parse(row.artifact_json);
    if (!validV11Artifact(artifact) || artifact.exhibitionId !== exhibitionId)
      throw new Error("stored catalog artifact is invalid");
    return artifact;
  }
  return { saveArtifact, getArtifact };
}

const validV12Artifact = artifact => {
  const provenance = (value, sourceRevision) => value === null || exactKeys(value, ["provider", "fixtureRef"]) &&
    typeof value.provider === "string" && !!value.provider.trim() &&
    typeof value.fixtureRef === "string" && value.fixtureRef === sourceRevision;
  if (!exactKeys(artifact, ["schemaVersion", "exhibitionId", "sourceRevision", "companies"]) ||
      artifact.schemaVersion !== "1.2.0" || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(artifact.exhibitionId ?? "") ||
      typeof artifact.sourceRevision !== "string" || !artifact.sourceRevision || !Array.isArray(artifact.companies) ||
      artifact.companies.length > 20_000) return false;
  const baseArtifact = structuredClone(artifact);
  baseArtifact.schemaVersion = "1.1.0";
  for (const company of baseArtifact.companies) {
    delete company.source?.director;
    delete company.enrichment?.taxesPaid;
    delete company.enrichment?.employeeCount;
  }
  if (!validV11Artifact(baseArtifact)) return false;
  return artifact.companies.every(company => {
    if (!company || !exactKeys(company, ["id", "name", "source", "enrichment", "registry", "qualification"]) ||
        !/^co-[a-f0-9]{20}$/.test(company.id ?? "") || typeof company.name !== "string" || !company.name.trim()) return false;
    const source = company.source, enrichment = company.enrichment;
    if (!exactKeys(source, ["sourceRecordId", "country", "booth", "href", "category", "description", "segment", "duplicateSourceRecordIds", "director"]) ||
        !exactKeys(source.director, ["name", "position", "provenance"]) ||
        ![source.director.name, source.director.position].every(value => value === null || typeof value === "string" && value.trim() && value.length <= 160) ||
        !provenance(source.director.provenance, artifact.sourceRevision) ||
        ((source.director.name !== null || source.director.position !== null) !== (source.director.provenance !== null)) ||
        !exactKeys(enrichment, ["status", "inn", "ogrn", "revenueRub", "revenueYear", "profitRub", "profitYear", "activity", "website", "provenance", "taxesPaid", "employeeCount"]) ||
        !exactKeys(enrichment.taxesPaid, ["amountRub", "period", "provenance"]) ||
        !(enrichment.taxesPaid.amountRub === null || Number.isSafeInteger(enrichment.taxesPaid.amountRub) && enrichment.taxesPaid.amountRub >= 0) ||
        !(enrichment.taxesPaid.period === null || typeof enrichment.taxesPaid.period === "string" && /^\d{4}$/.test(enrichment.taxesPaid.period)) ||
        !provenance(enrichment.taxesPaid.provenance, artifact.sourceRevision) ||
        ((enrichment.taxesPaid.amountRub !== null) !== (enrichment.taxesPaid.provenance !== null)) ||
        (enrichment.taxesPaid.amountRub === null && enrichment.taxesPaid.period !== null) ||
        (enrichment.taxesPaid.amountRub !== null && enrichment.taxesPaid.period === null) ||
        !exactKeys(enrichment.employeeCount, ["count", "period", "definition", "provenance"]) ||
        !(enrichment.employeeCount.count === null || Number.isSafeInteger(enrichment.employeeCount.count) && enrichment.employeeCount.count >= 0) ||
        !(enrichment.employeeCount.period === null || typeof enrichment.employeeCount.period === "string" && /^\d{4}$/.test(enrichment.employeeCount.period)) ||
        ![null, "year_end", "annual_average", "unknown"].includes(enrichment.employeeCount.definition) ||
        !provenance(enrichment.employeeCount.provenance, artifact.sourceRevision) ||
        (enrichment.employeeCount.count === null) !== (enrichment.employeeCount.definition === null) ||
        (enrichment.employeeCount.count === null) !== (enrichment.employeeCount.period === null) ||
        (enrichment.employeeCount.count === null) !== (enrichment.employeeCount.provenance === null)) return false;
    return typeof source.country === "string" && !!source.country.trim() &&
      /^src-[a-z0-9-]{1,48}$/.test(source.sourceRecordId ?? "") &&
      Array.isArray(source.duplicateSourceRecordIds) &&
      company.registry && company.qualification &&
      ["found", "not_found", "unavailable"].includes(enrichment.status) &&
      exactKeys(enrichment.provenance, ["provider", "fixtureRef"]) &&
      ["target", "near_target", "not_target", "unknown"].includes(company.qualification.classification);
  }) && new Set(artifact.companies.map(company => company.id)).size === artifact.companies.length;
};

export function createCatalogV12D1Repository(db, now = () => new Date().toISOString()) {
  if (!db?.prepare || typeof now !== "function") throw new TypeError("catalog v1.2 D1 binding required");
  async function saveArtifact({ profileId, artifact }) {
    if (!profileRefOk(profileId) || !validV12Artifact(artifact)) return { status: "invalid_artifact" };
    const json = JSON.stringify(artifact), contentSha = sha256(json), updatedAt = now();
    try {
      const prior = await db.prepare(`SELECT content_sha FROM crm_catalog_v12_artifacts
        WHERE profile_ref=? AND exhibition_id=?`).bind(profileId, artifact.exhibitionId).first();
      if (prior?.content_sha === contentSha) return { status: "replay", exhibitionId: artifact.exhibitionId,
        sourceRevision: artifact.sourceRevision };
      await db.prepare(`INSERT INTO crm_catalog_v12_artifacts
        (profile_ref,exhibition_id,source_revision,artifact_json,content_sha,updated_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT(profile_ref,exhibition_id) DO UPDATE SET
        source_revision=excluded.source_revision,artifact_json=excluded.artifact_json,
        content_sha=excluded.content_sha,updated_at=excluded.updated_at`)
        .bind(profileId, artifact.exhibitionId, artifact.sourceRevision, json, contentSha, updatedAt).run();
      return { status: "stored", exhibitionId: artifact.exhibitionId, sourceRevision: artifact.sourceRevision };
    } catch { return { status: "storage_unavailable" }; }
  }
  async function getArtifact({ profileId, exhibitionId }) {
    if (!profileRefOk(profileId) || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(exhibitionId ?? "")) return null;
    const row = await db.prepare(`SELECT artifact_json,content_sha FROM crm_catalog_v12_artifacts
      WHERE profile_ref=? AND exhibition_id=?`).bind(profileId, exhibitionId).first();
    if (!row) return null;
    if (sha256(row.artifact_json) !== row.content_sha) throw new Error("stored catalog integrity check failed");
    const artifact = JSON.parse(row.artifact_json);
    if (!validV12Artifact(artifact) || artifact.exhibitionId !== exhibitionId)
      throw new Error("stored catalog artifact is invalid");
    return artifact;
  }
  return { saveArtifact, getArtifact };
}

export function createCatalogVersionedD1Repository({ v11, v12 }) {
  if (typeof v11?.getArtifact !== "function" || typeof v12?.getArtifact !== "function")
    throw new TypeError("versioned catalog repositories required");
  return { async getArtifact(scope) {
    return await v12.getArtifact(scope) ?? await v11.getArtifact(scope);
  } };
}
