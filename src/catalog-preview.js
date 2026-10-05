const PREVIEW_GENERATOR_REVISION = "catalog-html-preview-1.0.0";

function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function allowlistedUrl(value) {
  if (typeof value !== "string" || !value.trim() || /[\s\u0000-\u001f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

const registryLabels = {
  ok: "Реестр: проверен",
  sanctioned: "Реестр: ограничение",
  not_found: "Реестр: не найдено",
  inactive: "Реестр: неактивен",
  unknown: "Реестр: статус неизвестен"
};

function renderCard(company) {
  const classification = ["target", "near_target", "not_target"].includes(company.qualification?.classification) ? company.qualification.classification : "not_target";
  const target = classification === "target";
  const near = classification === "near_target";
  const registryStatus = Object.hasOwn(registryLabels, company.registry?.status) ? company.registry.status : "unknown";
  const enrichmentStatus = ["found", "not_found", "unavailable"].includes(company.enrichment?.status) ? company.enrichment.status : "unavailable";
  const enrichmentLabels = { found: "Данные обогащены", not_found: "Данные не найдены", unavailable: "Обогащение недоступно" };
  const badges = [
    target ? '<span class="target-badge">ЦЕЛЕВАЯ</span>' : "",
    near ? '<span class="near-badge">НУЖНО УТОЧНИТЬ</span>' : "",
    classification === "not_target" ? '<span class="not-target-badge">НЕ ЦЕЛЕВАЯ</span>' : "",
    `<span class="enrichment-badge enrichment-${enrichmentStatus}" data-enrichment-status="${enrichmentStatus}">${escapeHtml(enrichmentLabels[enrichmentStatus])}</span>`,
    `<span class="registry-badge registry-${registryStatus}" data-registry-status="${registryStatus}">${escapeHtml(registryLabels[registryStatus])}</span>`
  ].join("");
  const safeWebsite = allowlistedUrl(company.enrichment?.website);
  const safeProfile = allowlistedUrl(company.source?.href);
  const links = [
    safeProfile ? `<a class="card-link profile-link" href="${escapeHtml(safeProfile)}" target="_blank" rel="noopener noreferrer">Профиль участника</a>` : "",
    safeWebsite ? `<a class="card-link website-link" href="${escapeHtml(safeWebsite)}" target="_blank" rel="noopener noreferrer">Сайт компании</a>` : ""
  ].filter(Boolean).join("");
  const name = escapeHtml(company.name);
  const booth = escapeHtml(company.source?.booth ?? "");
  const country = escapeHtml(company.source?.country ?? "");
  const searchText = escapeHtml(`${company.name} ${company.source?.booth ?? ""} ${company.source?.country ?? ""}`.toLocaleLowerCase("ru"));
  const id = /^[a-f0-9]{20}$/.test(String(company.id).replace(/^co-/, "")) ? company.id : "co-invalid";
  const registryReview = registryStatus === "ok" ? "false" : "true";
  return `<article class="company-card${target ? " is-target" : ""}" id="${escapeHtml(id)}" data-name="${searchText}" data-target="${target}" data-near="${near}" data-registry-review="${registryReview}">
      <div class="status-row">${badges}</div>
      <h3 class="company-name">${name}</h3>
      <div class="company-meta">${booth ? `<span class="company-stand">${booth}</span>` : ""}${country ? `<span class="company-country">${country}</span>` : ""}</div>
      <div class="card-links">${links || '<span class="no-links">Ссылки не указаны</span>'}</div>
    </article>`;
}

export function renderCatalogPreview({ buildId, artifact, buildReport }) {
  if (!buildId || !artifact || buildReport?.validation?.valid !== true || artifact.schemaVersion !== "1.0.0") {
    return { valid: false, html: "", report: { valid: false, error: "validated_build_required" } };
  }
  const groups = new Map();
  for (const company of artifact.companies) {
    const key = (String(company.source?.booth ?? "").trim()[0] ?? "#").toLocaleUpperCase("ru");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(company);
  }
  for (const rows of groups.values()) rows.sort((a, b) => a.name.localeCompare(b.name, "ru"));
  const sections = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, "ru")).map(([key, rows]) => {
    const sectionId = `zone-${[...key].map((char) => char.codePointAt(0).toString(16)).join("-") || "none"}`;
    return `<section class="letter-section" id="${sectionId}" data-section>
      <h2 class="letter-heading">${key === "#" ? "Без стенда" : `Зона ${escapeHtml(key)}`} <span>${rows.length} ${rows.length === 1 ? "участник" : "участников"}</span></h2>
      <div class="company-grid">${rows.map(renderCard).join("\n")}</div>
    </section>`;
  }).join("\n");
  const nav = [...groups.keys()].sort((a, b) => a.localeCompare(b, "ru")).map((key) => {
    const sectionId = `zone-${[...key].map((char) => char.codePointAt(0).toString(16)).join("-") || "none"}`;
    return `<a class="alpha-btn" href="#${sectionId}">${escapeHtml(key)}</a>`;
  }).join("");
  const sourceRevision = escapeHtml(artifact.sourceRevision);
  const escapedBuildId = escapeHtml(buildId);
  const html = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <meta name="preview-build-id" content="${escapedBuildId}">
  <meta name="preview-source-revision" content="${sourceRevision}">
  <title>Каталог выставки — synthetic preview</title>
  <style>
    :root{color-scheme:light;--green:#1b3c28;--green-soft:#e6efe9;--red:#d63b2a;--amber:#9a5b00;--bg:#fafaf8;--surface:#fff;--border:#e0ddd8;--text:#1a1a18;--muted:#666}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,sans-serif}
    .preview-banner{padding:8px 18px;background:#fff4d4;color:#573c00;text-align:center;font-weight:700;border-bottom:1px solid #e6ce88}
    .site-header,.hero{background:var(--green);color:#fff;padding:16px max(18px,calc((100% - 1100px)/2))}.site-header{display:flex;justify-content:space-between;gap:16px}.hero{padding-top:30px;padding-bottom:34px}
    .hero-eyebrow{font-size:12px;letter-spacing:.1em;text-transform:uppercase;opacity:.75}.hero-title{margin:4px 0 16px;font-size:clamp(24px,4vw,40px)}
    .search-box input{width:min(100%,430px);padding:11px 13px;border-radius:6px;border:1px solid #ffffff80;font:inherit}.filters{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.filter-btn{border:1px solid #ffffff99;border-radius:20px;background:transparent;color:#fff;padding:7px 12px;font:inherit;cursor:pointer}.filter-btn[aria-pressed=true]{background:#fff;color:var(--green)}
    .alpha-nav-wrap{position:sticky;top:0;background:var(--surface);border-bottom:1px solid var(--border);padding:10px 18px;z-index:2}.alpha-nav{display:flex;gap:6px;max-width:1100px;margin:auto;overflow:auto}.alpha-btn{color:var(--green);font-weight:700;text-decoration:none;padding:3px 7px}
    .stats-bar,.main{max-width:1100px;margin:auto;padding:18px}.stats-bar{font-weight:700;color:var(--green)}.main{padding-top:4px;padding-bottom:60px}.letter-section{margin:20px 0 34px;scroll-margin-top:55px}.letter-heading{border-bottom:1px solid var(--border);padding-bottom:8px}.letter-heading span{font-size:14px;color:var(--muted);font-weight:400}
    .company-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,250px),1fr));gap:12px}.company-card{border:1px solid var(--border);border-radius:9px;background:var(--surface);padding:14px;min-width:0}.company-card.is-target{border-left:4px solid #222}.status-row{display:flex;gap:6px;flex-wrap:wrap}.target-badge,.near-badge,.not-target-badge,.enrichment-badge,.registry-badge{font-size:11px;font-weight:700;border-radius:4px;padding:2px 7px}.target-badge{background:#222;color:white}.near-badge{background:#fff0d2;color:#704600}.not-target-badge{background:#ececea;color:#555}.enrichment-badge{background:#e9efff;color:#314b83}.enrichment-unavailable,.enrichment-not_found{background:#f1f1ef;color:#666}.registry-badge{background:#eef1ed;color:#304437}.registry-sanctioned,.registry-inactive,.registry-not_found{background:#ffeadf;color:#8b2c13}.registry-unknown{background:#fff0d2;color:#704600}
    .company-name{font-size:17px;margin:9px 0}.company-meta,.card-links{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.company-stand{background:var(--green);color:#fff;border-radius:4px;padding:3px 8px}.company-country,.no-links{color:var(--muted);font-size:13px}.card-links{margin-top:13px}.card-link{color:var(--green);text-underline-offset:3px}.no-results{padding:30px;text-align:center;color:var(--muted)}[hidden]{display:none!important}
    @media(max-width:600px){.site-header{display:block}.header-info{margin-top:4px}.filters{gap:6px}.filter-btn{font-size:14px}}
  </style>
</head>
<body data-preview-only="true">
  <div class="preview-banner" role="note">Синтетический preview · не опубликовано · ${escapedBuildId}</div>
  <header class="site-header"><strong>Каталог участников</strong><span class="header-info">Источник: ${sourceRevision}</span></header>
  <section class="hero" aria-labelledby="catalog-title"><div class="hero-eyebrow">Предпросмотр сборки выставки</div><h1 class="hero-title" id="catalog-title">Синтетический каталог</h1>
    <label class="search-box" for="searchInput"><span class="visually-hidden">Поиск компаний</span><input id="searchInput" type="search" autocomplete="off" placeholder="Поиск по названию, стенду или стране"></label>
    <div class="filters" role="group" aria-label="Фильтр компаний">
      <button class="filter-btn" type="button" data-filter="all" aria-pressed="true">Все</button>
      <button class="filter-btn" type="button" data-filter="target" aria-pressed="false">Целевые</button>
      <button class="filter-btn" type="button" data-filter="near" aria-pressed="false">Требуют уточнения</button>
      <button class="filter-btn" type="button" data-filter="not-target" aria-pressed="false">Не целевые</button>
      <button class="filter-btn" type="button" data-filter="registry-review" aria-pressed="false">Проверить реестр</button>
    </div>
  </section>
  <nav class="alpha-nav-wrap" aria-label="Навигация по стендам"><div class="alpha-nav" id="alphaNav">${nav}</div></nav>
  <div class="stats-bar"><span id="visibleCount">${artifact.companies.length}</span> компаний в preview · исходная сборка ${escapedBuildId}</div>
  <main class="main" id="catalog">${sections || '<p class="no-results">В артефакте нет компаний.</p>'}</main>
  <script>
    (()=>{const input=document.getElementById('searchInput'),buttons=[...document.querySelectorAll('[data-filter]')],cards=[...document.querySelectorAll('.company-card')],sections=[...document.querySelectorAll('[data-section]')],count=document.getElementById('visibleCount');let active='all';function apply(){const q=input.value.toLocaleLowerCase('ru').trim();let shown=0;for(const card of cards){const filterOk=active==='all'||active==='target'&&card.dataset.target==='true'||active==='near'&&card.dataset.near==='true'||active==='not-target'&&card.dataset.target==='false'&&card.dataset.near==='false'||active==='registry-review'&&card.dataset.registryReview==='true';const visible=filterOk&&(!q||card.dataset.name.includes(q));card.hidden=!visible;if(visible)shown++;}for(const section of sections)section.hidden=!section.querySelector('.company-card:not([hidden])');count.textContent=String(shown);}buttons.forEach(button=>button.addEventListener('click',()=>{active=button.dataset.filter;buttons.forEach(item=>item.setAttribute('aria-pressed',String(item===button)));apply();}));input.addEventListener('input',apply);})();
  </script>
</body>
</html>`;
  const requiredTokens = ["id=\"searchInput\"", "data-filter=\"target\"", "data-filter=\"near\"", "data-filter=\"not-target\"", "data-filter=\"registry-review\"", "id=\"alphaNav\"", "id=\"catalog\"", "class=\"company-card", "class=\"enrichment-badge", "class=\"registry-badge", "data-preview-only=\"true\""];
  const missing = requiredTokens.filter((token) => !html.includes(token));
  const linkCount = (html.match(/<a\b[^>]*href="https?:\/\//g) ?? []).length;
  const report = { schemaVersion: "1.0.0", buildId, sourceRevision: artifact.sourceRevision, generatorRevision: PREVIEW_GENERATOR_REVISION, valid: missing.length === 0, issues: missing.map((token) => ({ code: "required_preview_markup_missing", token })), companyCount: artifact.companies.length, linkCount, published: false };
  return { valid: report.valid, html, report };
}

export const catalogPreviewGeneratorRevision = PREVIEW_GENERATOR_REVISION;
