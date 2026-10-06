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
  if (artifact?.schemaVersion !== "1.1.0" || !Array.isArray(artifact.companies) ||
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

export function renderCatalogV11({ artifact, result, filters = {} }) {
  if (artifact?.schemaVersion !== "1.1.0" || result?.status !== "ok" || !Array.isArray(result.items))
    return { status: "invalid_catalog_view", html: "" };
  const options = (name, values, selected, labels = {}) => `<label>${name}<select name="${name}"><option value="">Все</option>${values.map(value =>
    `<option value="${escapeHtml(value)}"${selected === value ? " selected" : ""}>${escapeHtml(labels[value] ?? value)}</option>`).join("")}</select></label>`;
  const cards = result.items.map(company => {
    const source = company.source, enrichment = company.enrichment;
    const safeHref = safeSourceUrl(source.href);
    return `<article class="company-card" data-company-id="${escapeHtml(company.id)}"><h2>${escapeHtml(company.name)}</h2>
      <p>${escapeHtml(source.country)}${source.category ? ` · ${escapeHtml(source.category)}` : ""}</p>
      ${source.description ? `<p>${escapeHtml(source.description)}</p>` : ""}
      <p>Выручка: ${escapeHtml(moneyLabel(enrichment.revenueRub))}${enrichment.revenueYear ? ` (${enrichment.revenueYear})` : ""}</p>
      <p>Прибыль: ${escapeHtml(moneyLabel(enrichment.profitRub))}${enrichment.profitYear ? ` (${enrichment.profitYear})` : ""}</p>
      ${safeHref ? `<a href="${escapeHtml(safeHref)}" rel="noopener noreferrer">Профиль выставки</a>` : ""}</article>`;
  }).join("");
  const html = `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>Каталог ${escapeHtml(artifact.exhibitionId)}</title><main>
    <h1>Каталог выставки ${escapeHtml(artifact.exhibitionId)}</h1><form method="get"><label>Поиск<input name="query" value="${escapeHtml(filters.query ?? "")}"></label>
    ${options("classification", [...classifications], filters.classification, { target: "Целевая", near_target: "Почти целевая", not_target: "Не целевая", unknown: "Не подтверждена" })}
    ${options("revenueBand", [...revenueBands], filters.revenueBand)}${options("profitBand", [...profitBands], filters.profitBand)}
    <button type="submit">Показать</button></form><p>Найдено: ${result.total}</p>${cards || "<p>Ничего не найдено.</p>"}</main></html>`;
  return { status: "ok", html };
}

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: {
  "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store",
  "x-content-type-options": "nosniff"
} });

export function createCatalogV11ReadHandler({ repository, resolveTrustedProfile }) {
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
    const view = renderCatalogV11({ artifact, result, filters });
    if (view.status !== "ok") return reply(503, { error: "catalog_unavailable" });
    return new Response(view.html, { status: 200, headers: {
      "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store",
      "x-content-type-options": "nosniff", "referrer-policy": "same-origin",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
    } });
  };
}
