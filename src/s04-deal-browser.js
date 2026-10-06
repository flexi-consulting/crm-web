const escape = (value) => String(value ?? "").replace(/[&<>\"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
})[char]);
const csrf = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

function shell(title, body) {
  return new Response(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escape(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:48rem;margin:auto;padding:1rem;color:#172a22;background:#f8faf8}main,form{display:grid;gap:.8rem}.card{background:white;border:1px solid #c9d4cd;border-radius:.5rem;padding:1rem}label{display:grid;gap:.25rem}input,textarea,button{font:inherit;padding:.5rem}textarea{min-height:7rem}button{width:max-content}dl{display:grid;grid-template-columns:max-content 1fr;gap:.25rem 1rem}dt{font-weight:600}dd{margin:0}a{color:#17613c}</style></head><body><main>${body}</main></body></html>`, {
    status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store",
      "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" }
  });
}

const hidden = (name, value) => `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`;
const detailsMarkup = (details) => `<dl>${Object.entries({
  "Компания": details.companyName ?? details.companyId, "Выставка": details.exhibitionId,
  "Статус Weeek": details.statusId, "Название": details.title, "Источник": details.source,
  "Тип": details.dealType, "ИНН": details.companyInn, "Контакт": details.contactName,
  "Описание": details.dealComment
}).map(([key, value]) => `<dt>${escape(key)}</dt><dd>${escape(value)}</dd>`).join("")}</dl>`;

export function renderS04DealPreparation({ item, buildId, exhibitionId, csrfToken }) {
  if (!item || !/^build-[a-f0-9]{24}$/.test(buildId ?? "") ||
      !/^co-[a-f0-9]{20}$/.test(item.id ?? "") || !csrf(csrfToken))
    return new Response(JSON.stringify({ error: "deal_review_unavailable" }), { status: 503,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  const title = `Встреча с ${item.name} — ${exhibitionId}`;
  const href = `/catalogs/${buildId}/participants/${item.id}`;
  return shell("Подготовить сделку", `<a href="${href}">← Карточка компании</a><h1>Подготовить сделку: ${escape(item.name)}</h1><p>Это подготовка черновика. Отправка в Weeek начнётся только после проверки сводки и отдельного подтверждения.</p><section class="card"><form method="post" action="/deal-workflow/prepare">
    ${hidden("_csrf", csrfToken)}${hidden("buildId", buildId)}${hidden("companyId", item.id)}${hidden("exhibitionId", exhibitionId)}
    <label>Название сделки<input name="title" maxlength="160" required value="${escape(title)}"></label>
    <label>ИНН<input name="companyInn" maxlength="20" required value="${escape(item.enrichment?.inn ?? "")}"></label>
    <label>Контактное лицо<input name="contactName" maxlength="160" required></label>
    <label>Комментарий к сделке<textarea name="dealComment" maxlength="2000" required></textarea></label>
    <button type="submit">Подготовить сводку</button></form></section>`);
}

export function renderS04DealReview({ review, csrfToken }) {
  if (!review || !/^review-[0-9a-f-]{36}$/.test(review.reviewId ?? "") ||
      typeof review.revision !== "string" || !csrf(csrfToken))
    return shell("Не удалось подготовить сделку", "<h1>Не удалось подготовить сделку</h1><p>Обновите страницу и проверьте доступ.</p>");
  return shell("Проверка сделки", `<h1>Проверьте данные сделки</h1><section class="card">${detailsMarkup(review.details)}</section><p>После подтверждения запись будет отправлена в Weeek. Если ответ потеряется, система сначала проверит результат и не отправит повторный запрос на создание.</p><form method="post" action="/deal-workflow/confirm">${hidden("_csrf", csrfToken)}${hidden("reviewId", review.reviewId)}${hidden("revision", review.revision)}<button type="submit">Подтверждаю создание сделки</button></form>`);
}

export function renderS04DealOutcome({ result, csrfToken, approvalIssuer }) {
  const status = result?.status;
  if (result?.error === "human_approval_required" && /^review-[0-9a-f-]{36}$/.test(result.reviewId ?? "") &&
      /^[a-f0-9]{64}$/.test(result.revision ?? "") && csrf(csrfToken)) {
    let approvalUrl;
    try {
      approvalUrl = new URL(result.approvalUrl);
      if (approvalUrl.protocol !== "https:" || approvalUrl.origin !== approvalIssuer ||
          approvalUrl.pathname !== "/v1/connected-app-approvals/review" ||
          approvalUrl.searchParams.getAll("intent").length !== 1 || [...approvalUrl.searchParams.keys()].some((key) => key !== "intent"))
        approvalUrl = null;
    } catch { approvalUrl = null; }
    if (!approvalUrl) return shell("Подтверждение недоступно", "<h1>Не удалось открыть подтверждение</h1><p>Проверьте связь с Control Plane.</p>");
    return shell("Подтверждение сделки", `<h1>Сначала подтвердите точные данные в Control Plane</h1><p>Откройте страницу Control Plane. Она покажет данные операции перед подтверждением. После подтверждения вернитесь сюда и отдельно отправьте команду создания.</p><p><a rel="noreferrer" href="${escape(approvalUrl.href)}">Проверить и подтвердить действие в Control Plane</a></p><form method="post" action="/deal-workflow/confirm">${hidden("_csrf", csrfToken)}${hidden("reviewId", result.reviewId)}${hidden("revision", result.revision)}<button type="submit">Я подтвердил в Control Plane — создать сделку</button></form>`);
  }
  if (status === "unknown" && /^op-[0-9a-f-]{36}$/.test(result.operationId ?? ""))
    return shell("Результат сделки уточняется", `<h1>Результат уточняется</h1><p>Weeek мог принять запрос, но ответ пока не подтверждён. Повторного запроса на создание не будет. Запустите только сверку результата.</p><form method="post" action="/deal-workflow/reconcile">${hidden("_csrf", csrfToken)}${hidden("operationId", result.operationId)}<button type="submit">Сверить с Weeek</button></form>`);
  if (status === "created" && /^op-[0-9a-f-]{36}$/.test(result.operationId ?? ""))
    return shell("Сделка создана", `<h1>Сделка создана</h1><p>Сделка ${escape(result.dealId)} подтверждена в Weeek и связана с карточкой участника.</p><p><a href="/api/v1/deal-operations/${escape(result.operationId)}">Открыть карточку операции</a></p>`);
  return shell("Не удалось создать сделку", `<h1>Сделка не создана</h1><p>Статус: ${escape(status ?? "неизвестен")}. Проверьте карточку операции или обратитесь к владельцу CRM.</p>`);
}
