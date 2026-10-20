// Shared contract between the published exhibition catalogs and the Telegram
// deal bots.
//
// A catalog card links to the bot as
//   https://t.me/<bot>?start=<eventKey>_deal_<companyId>
// The bot has to parse that payload, resolve the company in the catalog JSON
// and create the Weeek deal. Two workers are involved:
//
//   * flexi-telegram-deal-bot  - owns the Weeek credentials, the catalog
//                                binding and the pre-lead storage
//   * trained-assist-tg-bot-sales - serves @cmr_management_bot, the username
//                                every published catalog deep-links to
//
// Both sides share the parsing and the reply format from this module so the
// two workers cannot drift apart. The module is inlined into the worker
// bundles by scripts/patch-workers-exhibition-deal.mjs, therefore every export
// name is prefixed with `exhibition` to stay clear of the bundle scope.

const EXHIBITION_DEAL_PAYLOAD_PATTERN = /^(?:(?<eventKey>[a-z0-9-]+)_)?deal_(?<companyId>[a-z0-9]+)$/iu;
const EXHIBITION_DEAL_START_PATTERN = /^\/start(?:@[a-z0-9_]+)?\s+(?<payload>[a-z0-9_:-]+)\s*$/iu;

export function parseExhibitionDealStart(text) {
  const start = String(text || "").trim().match(EXHIBITION_DEAL_START_PATTERN);
  if (!start) return null;
  const raw = start.groups.payload;
  const payload = raw.match(EXHIBITION_DEAL_PAYLOAD_PATTERN);
  if (!payload) return null;
  const companyId = (payload.groups.companyId || "").toLowerCase();
  if (!companyId) return null;
  return {
    raw,
    eventKey: (payload.groups.eventKey || "").toLowerCase(),
    companyId
  };
}

export function normalizeExhibitionDealRequest(body) {
  const source = body && typeof body === "object" ? body : {};
  const eventKey = String(source.eventKey || "").trim().toLowerCase();
  const companyId = String(source.companyId || "").trim().toLowerCase();
  if (!companyId) {
    return { ok: false, error: "companyId is required" };
  }
  if (!/^[a-z0-9]+$/.test(companyId)) {
    return { ok: false, error: `companyId has an unsupported format: ${companyId}` };
  }
  if (eventKey && !/^[a-z0-9-]+$/.test(eventKey)) {
    return { ok: false, error: `eventKey has an unsupported format: ${eventKey}` };
  }
  return {
    ok: true,
    eventKey,
    companyId,
    chatId: String(source.chatId || "").trim(),
    userId: String(source.userId || "").trim(),
    userName: String(source.userName || "").trim(),
    dryRun: source.dryRun === true
  };
}

export function buildExhibitionDealRequestBody(payload, context = {}) {
  const source = payload || {};
  return {
    eventKey: source.eventKey || "",
    companyId: source.companyId || "",
    payload: source.raw || "",
    chatId: context.chatId === undefined || context.chatId === null ? "" : String(context.chatId),
    userId: context.userId === undefined || context.userId === null ? "" : String(context.userId),
    userName: context.userName || ""
  };
}

export function formatExhibitionDealResult(result) {
  if (!result || result.ok !== true) {
    const error = (result && (result.error || result.detail)) || "unknown_error";
    return [`⚠️ Не удалось создать сделку из каталога.`, `Причина: ${error}`].join("\n");
  }
  const headline = result.existingDeal
    ? `✅ Сделка уже создана: ${result.companyName || "компания из каталога"}`
    : `✅ Сделка создана: ${result.companyName || "компания из каталога"}`;
  const lines = [headline];
  if (result.sourceLabel) lines.push(`Источник: ${result.sourceLabel}`);
  if (result.eventKey) lines.push(`Выставка: ${result.eventKey}`);
  if (result.dealId) lines.push(`ID сделки: ${result.dealId}`);
  if (result.dealUrl) lines.push(result.dealUrl);
  if (result.preleadId) lines.push(`Лид: ${result.preleadId}`);
  const warnings = Array.isArray(result.warnings) ? result.warnings.filter(Boolean) : [];
  if (warnings.length) lines.push(`Предупреждения: ${warnings.join("; ")}`);
  return lines.join("\n");
}

export function formatExhibitionDealDryRun(result) {
  if (!result || result.ok !== true) {
    const error = (result && (result.error || result.detail)) || "unknown_error";
    return [`⚠️ Компания не найдена в каталоге.`, `Причина: ${error}`].join("\n");
  }
  const lines = [`🧪 Dry-run: ${result.companyName || "компания из каталога"}`];
  if (result.sourceLabel) lines.push(`Источник: ${result.sourceLabel}`);
  if (result.title) lines.push(`Заголовок сделки: ${result.title}`);
  if (result.preleadId) lines.push(`Лид: ${result.preleadId}`);
  return lines.join("\n");
}
