const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[char]);
const safeUrl = (value) => {
  if (typeof value !== "string" || /\s/.test(value)) return null;
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) && parsed.hostname &&
      !parsed.username && !parsed.password ? parsed.href : null;
  } catch { return null; }
};
const labels = { target: "Целевая", near_target: "Почти целевая", not_target: "Не отнесена к целевым", unknown: "Статус не подтверждён" };
const link = (url, label) => {
  const safe = safeUrl(url);
  return safe ? `<a href="${escape(safe)}" target="_blank" rel="noopener noreferrer">${label}</a>` : "";
};
const field = (label, value) => value == null || value === "" ? "" :
  `<dt>${escape(label)}</dt><dd>${escape(value)}</dd>`;
const pathFor = (buildId, companyId) => `/catalogs/${buildId}/participants/${companyId}`;

function shell(title, content) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${escape(title)}</title><style>
body{font:16px/1.5 system-ui,sans-serif;max-width:72rem;margin:auto;padding:1rem;color:#172a22;background:#f8faf8}
a{color:#17613c}a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #ca551f}
main{display:grid;gap:1rem}.card{background:white;border:1px solid #c9d4cd;border-radius:.5rem;padding:1rem}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(16rem,1fr));gap:.75rem}
form{display:flex;flex-wrap:wrap;gap:.5rem}input,select,button{font:inherit;padding:.4rem}
dl{display:grid;grid-template-columns:max-content 1fr;gap:.25rem 1rem}dt{font-weight:600}dd{margin:0}
small{color:#46594d}nav{display:flex;gap:1rem;flex-wrap:wrap}
</style></head><body><main>${content}</main></body></html>`;
}

// Render only data returned by the profile-scoped D1 domain read. No browser token,
// mutable actions or legacy bot links are embedded in this offline slice.
export function renderBuiltCatalogBrowser(data, { query = "", classification = null, companyId = null } = {}) {
  const { buildId, exhibitionId, sourceRevision, items } = data;
  const base = `/catalogs/${buildId}`;
  const meta = `<small>Выставка: ${escape(exhibitionId)} · Ревизия источника: ${escape(sourceRevision)}</small>`;
  if (companyId) {
    const item = items[0];
    const title = item.name;
    const classificationLabel = labels[item.qualification.classification] ?? "Статус не подтверждён";
    const details = [field("Статус", classificationLabel), field("Причина", item.qualification.reason),
      field("Страна", item.source.country), field("Стенд", item.source.booth),
      field("ИНН", item.enrichment.inn), field("ОГРН", item.enrichment.ogrn),
      field("Категория", item.source.category), field("Описание", item.source.description),
      field("Сегмент", item.source.segment),
      field("Выручка, ₽", item.enrichment.revenueRub), field("Год выручки", item.enrichment.revenueYear),
      field("Прибыль, ₽", item.enrichment.profitRub), field("Год прибыли", item.enrichment.profitYear),
      field("Данные", item.enrichment.status === "found" ? "Найдены" : "Неизвестны"),
      field("Реестр", item.registry.status), field("Источник обогащения", item.enrichment.provenance?.provider)]
      .filter(Boolean).join("");
    return shell(title, `<nav><a href="${base}">← Каталог</a></nav><h1>${escape(title)}</h1>${meta}
      <article class="card"><dl>${details}</dl><nav>${link(item.source.href, "Профиль выставки")}
      ${link(item.enrichment.website, "Сайт компании")}</nav></article>
      <p><a href="${base}/participants/${item.id}/deal">Подготовить сделку</a></p>`);
  }
  const cards = items.map((item) => `<article class="card"><h2><a href="${pathFor(buildId, item.id)}">${escape(item.name)}</a></h2>
    <p>${escape(labels[item.qualification.classification] ?? "Статус не подтверждён")}</p>
    <small>${escape(item.source.country)}${item.source.booth ? ` · стенд ${escape(item.source.booth)}` : ""}${item.source.category ? ` · ${escape(item.source.category)}` : ""}</small>
    ${item.source.description ? `<p>${escape(item.source.description)}</p>` : ""}
    <p>Выручка: ${escape(item.enrichment.revenueRub ?? "Неизвестно")}${item.enrichment.revenueYear ? ` (${item.enrichment.revenueYear})` : ""}</p>
    <p>Прибыль: ${escape(item.enrichment.profitRub ?? "Неизвестно")}${item.enrichment.profitYear ? ` (${item.enrichment.profitYear})` : ""}</p></article>`).join("");
  return shell(`Каталог ${exhibitionId}`, `<h1>Каталог выставки ${escape(exhibitionId)}</h1>${meta}
    <form method="get" action="${base}"><label>Поиск <input name="q" maxlength="120" value="${escape(query)}"></label>
    <label>Статус <select name="classification"><option value="">Все</option>${Object.entries(labels).map(([key, label]) =>
      `<option value="${key}"${classification === key ? " selected" : ""}>${label}</option>`).join("")}</select></label>
    <button type="submit">Показать</button></form><p>Найдено: ${items.length}</p>
    ${items.length ? `<div class="grid">${cards}</div>` : "<p>Участники не найдены.</p>"}`);
}

export const browserHeaders = { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store",
  "x-content-type-options": "nosniff", "referrer-policy": "same-origin", "x-frame-options": "DENY",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" };
