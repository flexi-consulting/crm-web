// Injected into the sales bot bundle (trained-assist-tg-bot-sales), the worker
// that serves @cmr_management_bot.
//
// Every published exhibition catalog deep-links to that username:
//
//   https://t.me/cmr_management_bot?start=<eventKey>_deal_<companyId>
//
// The bot did not know the payload: the start command fell through to the
// generic greeting. This module teaches the bot the exhibition contract. The
// bot owns no Weeek credentials, so it does not create the deal itself - it
// calls the exhibition deal bot over a private HTTP bridge and reports the
// result back into the chat.

const EXHIBITION_DEAL_API_PATH = "/api/exhibition/deal";

function exhibitionEscapeHtml(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function handleExhibitionDealStart(msg, env, chatId, payload) {
  const threadId = threadIdOf(msg);
  const apiUrl = String(env.EXHIBITION_DEAL_API_URL || "").trim().replace(/\/+$/, "");
  const apiKey = String(env.EXHIBITION_DEAL_API_KEY || "").trim();
  if (!apiUrl || !apiKey) {
    await sendMessage(
      env.BOT_TOKEN,
      chatId,
      "⚠️ Мост выставочных сделок не настроен. Сообщите администратору.",
      threadExtra(threadId)
    );
    return { ok: false, error: "bridge_not_configured" };
  }
  const session = await getSession(env.SESSIONS, chatId, threadId);
  if (!session || !session.username) {
    await sendMessage(
      env.BOT_TOKEN,
      chatId,
      "⚠️ Сначала выполните /login, потом откройте ссылку каталога ещё раз.",
      threadExtra(threadId)
    );
    return { ok: false, error: "login_required" };
  }
  let result = null;
  try {
    const response = await fetch(`${apiUrl}${EXHIBITION_DEAL_API_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Exhibition-Key": apiKey
      },
      body: JSON.stringify(buildExhibitionDealRequestBody(payload, {
        chatId,
        userId: msg.from?.id,
        userName: msg.from?.username
      }))
    });
    const body = await response.text();
    try {
      result = JSON.parse(body);
    } catch {
      result = null;
    }
    if (!result || typeof result.ok !== "boolean") {
      result = { ok: false, error: `bridge responded with ${response.status}` };
    }
    if (!response.ok && result.ok) {
      result = { ok: false, error: result.error || `bridge responded with ${response.status}` };
    }
  } catch (error) {
    result = { ok: false, error: String(error?.message || error) };
  }
  await sendMessage(
    env.BOT_TOKEN,
    chatId,
    exhibitionEscapeHtml(formatExhibitionDealResult(result)),
    threadExtra(threadId)
  );
  return result;
}
