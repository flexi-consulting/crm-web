// Injected into the exhibition deal bot bundle (flexi-telegram-deal-bot).
//
// The published catalogs deep-link to @cmr_management_bot, which is served by a
// different worker (trained-assist-tg-bot-sales). That worker owns no Weeek
// credentials, so the catalog deal has to be created here, by the worker that
// already owns the catalog binding, the Weeek credentials and the pre-lead
// storage.
//
// New private endpoint:
//
//   POST /api/exhibition/deal
//   X-Exhibition-Key: <EXHIBITION_DEAL_API_KEY>
//   { "eventKey": "heatpower2026", "companyId": "c3", "chatId": "1", "userId": "2" }
//
// The body is answered with the same payload the sales bot formats for the
// chat. `dryRun: true` resolves the company and prepares the draft without
// touching Weeek.
//
// The deal is created by the same helpers the Telegram intake uses, so the
// resulting Weeek deal, its comment and the pre-lead marker match the flow a
// user gets when the payload arrives through /start.

var EXHIBITION_DEAL_API_PATH = "/api/exhibition/deal";
var EXHIBITION_DEAL_API_KEY_HEADER = "x-exhibition-key";

function exhibitionDealApiAuthorized(request, env) {
  var expected = clean3(env.EXHIBITION_DEAL_API_KEY);
  var provided = clean3(request.headers.get(EXHIBITION_DEAL_API_KEY_HEADER));
  if (!expected || !provided) return false;
  return provided === expected;
}

// The published catalogs do not carry a `meta` block, so the source label and
// the page url of a catalog company would fall back to the RosUpack defaults.
// The worker keeps its own map for that case; a catalog that does ship a
// `meta` block always wins.
function exhibitionEventMeta(env, eventKey) {
  var raw = clean3(env.TELEGRAM_DEAL_EVENT_META_JSON);
  if (!raw) return null;
  try {
    var parsed = JSON.parse(raw);
    var entry = parsed[clean3(eventKey).toLowerCase()];
    return entry && typeof entry === "object" ? entry : null;
  } catch {
    return null;
  }
}

function mergeExhibitionEventMeta(env, meta, eventKey) {
  var fallback = exhibitionEventMeta(env, eventKey);
  if (!fallback) return meta;
  var merged = Object.assign({}, meta);
  for (var key of Object.keys(fallback)) {
    if (!clean3(merged[key]) && clean3(fallback[key])) merged[key] = fallback[key];
  }
  return merged;
}

async function handleExhibitionDealRequest(request, env) {
  if (!exhibitionDealApiAuthorized(request, env)) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }
  if (request.method !== "POST") {
    return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  }
  var body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  var request2 = normalizeExhibitionDealRequest(body);
  if (!request2.ok) {
    return jsonResponse({ ok: false, error: request2.error }, 400);
  }
  var result = await createExhibitionDealForCatalog(env, request2);
  if (!result.ok) {
    return jsonResponse({
      ok: false,
      error: result.error || "deal_failed",
      detail: result.detail || ""
    }, result.status || 500);
  }
  return jsonResponse(result);
}

async function createExhibitionDealForCatalog(env, request) {
  var eventKey = clean3(request.eventKey).toLowerCase();
  var companyId = clean3(request.companyId).toLowerCase();
  var company = null;
  var meta = {};
  var resolvedEventKey = eventKey;
  try {
    var resolved = await fetchRosupackCompany(env, companyId, eventKey);
    company = resolved.company;
    meta = resolved.meta || {};
    if (!resolvedEventKey && resolved.eventKey) resolvedEventKey = clean3(resolved.eventKey).toLowerCase();
  } catch (error) {
    return {
      ok: false,
      error: "catalog_unavailable",
      detail: safeErrorMessage(error),
      status: 502
    };
  }
  if (!company) {
    return {
      ok: false,
      error: "company_not_found",
      detail: `eventKey=${resolvedEventKey} companyId=${companyId}`,
      status: 404
    };
  }
  meta = mergeExhibitionEventMeta(env, meta, resolvedEventKey);
  var companyName = truncateTitle(clean3(company.name));
  if (!companyName) {
    return {
      ok: false,
      error: "company_name_missing",
      detail: `eventKey=${resolvedEventKey} companyId=${companyId}`,
      status: 422
    };
  }
  var sourceLabel = rosupackSourceLabel(env, meta, resolvedEventKey);
  // The published catalog addresses its pre-lead by the company id it publishes
  // (`heatpower2026-3`), while the Telegram payload only carries the short id
  // (`c3`). The notes and the rejection state of the catalog page live under
  // the published id, so the deal marker has to use the same one.
  var preleadCompanyId = clean3(company.id) || companyId;
  var session = await buildExhibitionDealSession(env, {
    company,
    meta,
    eventKey: resolvedEventKey,
    companyId,
    preleadCompanyId,
    companyName,
    sourceLabel,
    chatId: request.chatId,
    userId: request.userId,
    userName: request.userName
  });
  var preleadId = resolvedEventKey ? sitePredealId(resolvedEventKey, preleadCompanyId) : "";
  if (request.dryRun) {
    return {
      ok: true,
      dryRun: true,
      companyName,
      title: session.title,
      sourceLabel,
      eventKey: resolvedEventKey,
      companyId,
      preleadId,
      companyInfo: session.companyInfo,
      dealComment: session.dealComment,
      warnings: session.warnings || []
    };
  }
  // A second click on the same company card must not create a second deal.
  if (preleadId && preleadStorageAvailable(env)) {
    try {
      var existingPrelead = await getStoredPrelead(env, preleadId);
      var existingDeal = existingPrelead && existingPrelead.messages &&
        existingPrelead.messages.find((item) => item.type === "site_deal" && item.siteDeal && item.siteDeal.dealId);
      if (existingDeal) {
        return {
          ok: true,
          existingDeal: true,
          companyName,
          title: session.title,
          sourceLabel,
          eventKey: resolvedEventKey,
          companyId,
          dealId: String(existingDeal.siteDeal.dealId),
          dealUrl: buildDealUrl(env, String(existingDeal.siteDeal.dealId), session),
          preleadId,
          warnings: []
        };
      }
    } catch (error) {
      // A failed duplicate check must not block the deal.
    }
  }
  var dealId = "";
  var dealUrl = "";
  var warnings = Array.isArray(session.warnings) ? session.warnings.slice() : [];
  try {
    await resolveSelectedSourceOption(session, env, { createIfMissing: Boolean(session.createSourceOption) });
    prepareSessionForNewDeal(session, env);
    if (!ensureNextTaskFromSession(session, env)) {
      session.nextTaskTitle = "Связаться с компанией";
    }
    await verifyFinalDealDraftWithLlm(env, session, { skipNextTask: false });
    var description = buildDealDescription(session, env, true);
    var dealResult = await createWeeekDeal(env, session, description);
    var deal = dealResult.deal;
    session.state = "completed";
    session.dealId = String(deal.id);
    session.dealUrl = buildDealUrl(env, session.dealId, session);
    dealId = session.dealId;
    dealUrl = session.dealUrl;
    warnings = [...warnings, ...(dealResult.warnings || [])];
    if (session.sourceWarning) warnings.push(session.sourceWarning);
    var customFieldSync = await syncDealCustomFieldsAfterCreate(env, session);
    if (customFieldSync.error) {
      warnings.push(`части полей сделки не записались: ${customFieldSync.error}`);
    }
    var crmEntitySync = await syncCrmEntitiesToWeeekDeal(env, session, deal);
    if (crmEntitySync.error) {
      warnings.push(`компания/контакт не синхронизировались: ${crmEntitySync.error}`);
    }
    var nextTaskSync = await syncNextTaskToWeeekDeal(env, session);
    if (nextTaskSync.error) {
      warnings.push(`следующая задача не синхронизировалась: ${nextTaskSync.error}`);
    }
    var dealCommentSync = await syncInitialDealComment(env, session, description, clean3(request.chatId));
    if (dealCommentSync.error) {
      warnings.push(`комментарий к сделке не синхронизировался: ${dealCommentSync.error}`);
    }
  } catch (error) {
    return {
      ok: false,
      error: "deal_creation_failed",
      detail: safeErrorMessage(error),
      status: 502
    };
  }
  if (resolvedEventKey && preleadCompanyId && preleadStorageAvailable(env)) {
    try {
      var prelead = await getStoredPrelead(env, preleadId);
      if (!prelead) {
        prelead = await createStoredPrelead(env, sitePredealRecord({
          preleadId,
          companyId: preleadCompanyId,
          companyName,
          eventKey: resolvedEventKey,
          hall: "",
          stand: ""
        }, env), []);
      }
      await appendStoredPreleadMessage(env, preleadId, {
        messageId: `site-deal-${Date.now()}`,
        date: new Date().toISOString(),
        type: "site_deal",
        text: "Сделка создана",
        siteDeal: { dealId, createdAt: new Date().toISOString() }
      });
    } catch (error) {
      warnings.push(`отметка в лиде не записалась: ${safeErrorMessage(error)}`);
    }
  }
  return {
    ok: true,
    companyName,
    title: session.title,
    sourceLabel,
    eventKey: resolvedEventKey,
    companyId,
    dealId,
    dealUrl,
    preleadId,
    warnings
  };
}

async function buildExhibitionDealSession(env, context) {
  var eventKey = clean3(context.eventKey);
  var companyId = clean3(context.companyId);
  var preleadCompanyId = clean3(context.preleadCompanyId) || companyId;
  var company = context.company || {};
  var meta = context.meta || {};
  var chatId = clean3(context.chatId) || "0";
  var userId = clean3(context.userId) || "0";
  var message = {
    message_id: 1,
    date: Math.floor(Date.now() / 1000),
    chat: { id: Number(chatId) || 0, type: "private" },
    from: { id: Number(userId) || 0, username: clean3(context.userName) || undefined },
    text: `/start ${eventKey ? `${eventKey}_deal_${companyId}` : `deal_${companyId}`}`
  };
  var session = createBatchIntakeSession(message, "personal", env);
  session.batchMode = false;
  session.sourceOrigin = eventKey || "rosupack_floorplan";
  session.companyName = context.companyName;
  session.title = titleWithPrefix(session.companyName, env);
  session.titleNeedsInput = false;
  session.awaitingTitle = false;
  session.dealTypeKind = rosupackDealTypeKey(meta) || "conference";
  applyExplicitSourceDetail(session, context.sourceLabel, env);
  if (clean3(meta.source_option_id)) {
    session.sourceOptionId = clean3(meta.source_option_id);
    session.createSourceOption = false;
  }
  session.companyInfo = rosupackCompanyInfo(company);
  session.dealComment = rosupackDealComment(company, env, meta, eventKey);
  var captured = commandCapturedMessage(message, rosupackCapturedText(company, env, meta, eventKey), env);
  captured.type = "rosupack_deal_payload";
  captured.payload = exhibitionCompanyPayload(company, { eventKey, companyId });
  appendMessage(session, captured);
  await appendSitePredealNotesToSession(env, session, {
    eventKey,
    companyId: preleadCompanyId,
    companyName: context.companyName,
    sourceLabel: context.sourceLabel
  });
  return session;
}