// Offline contract mirror of the legacy Telegram deal bot's exhibition deal payload handling.
//
// Source of truth: the deployed `flexi-telegram-deal-bot` Worker
// (parseRosupackStartPayload, findRosupackCompanyInEvent, exhibitionCompanyPayload,
// rosupackCompaniesUrlByEvent, plus the bot helpers clean3 and parseJson2).
//
// This module is pure: no network calls, no provider writes, no filesystem access.
// It exists so the published exhibition catalog contract can be verified offline
// and in a read-only live probe. It is not a second implementation of the bot.

export const EXHIBITION_DEAL_PAYLOAD_PATTERN =
  /^(?:(?<eventKey>[a-z0-9-]+)_)?deal_(?<companyId>[a-z0-9]+)$/iu;

const clean = (value) => String(value ?? "").trim();

const parseJson2 = (body) => {
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
};

export function parseExhibitionBindingJson(bindingJson) {
  if (bindingJson && typeof bindingJson === "object") return bindingJson;
  return parseJson2(clean(bindingJson));
}

export function parseExhibitionDealPayload(value) {
  const raw = clean(value);
  const match = raw.match(EXHIBITION_DEAL_PAYLOAD_PATTERN);
  return {
    raw,
    eventKey: clean(match?.groups?.eventKey).toLowerCase(),
    companyId: clean(match?.groups?.companyId),
    matched: Boolean(match)
  };
}

export function exhibitionCompaniesUrlByEvent(bindingJson, eventKey) {
  const key = clean(eventKey).toLowerCase();
  if (!key) return "";
  const parsed = parseExhibitionBindingJson(bindingJson);
  if (parsed && typeof parsed === "object" && clean(parsed[key])) return clean(parsed[key]);
  return "";
}

export function resolveExhibitionDealCompany({ companies, eventKey, companyId } = {}) {
  if (!Array.isArray(companies)) return { company: null, matchedBy: null };
  const rows = companies.filter((item) => item && typeof item === "object");
  const key = clean(eventKey).toLowerCase();
  const id = clean(companyId);
  const payload = `deal_${id}`;
  const eventPayload = key ? `${key}_${payload}` : payload;

  const byPayload = rows.find((item) =>
    [item.deal_payload, item.telegramPayload, item.telegram_payload]
      .map(clean)
      .some((value) => value && (value === payload || value === eventPayload)));
  if (byPayload) return { company: byPayload, matchedBy: "deal_payload" };

  const byId = rows.find((item) => clean(item.id) === id);
  if (byId) return { company: byId, matchedBy: "company_id" };

  const index = Number(id);
  if (Number.isInteger(index) && index >= 0 && index < rows.length) {
    return { company: rows[index], matchedBy: "index" };
  }
  return { company: null, matchedBy: null };
}

export function exhibitionDealPayloadFor(company, payload = {}) {
  const source = company && typeof company === "object" ? company : {};
  const explicit = clean(source.dealPayload) || clean(source.telegramPayload) ||
    clean(source.telegram_payload);
  if (explicit) return explicit;
  const eventKey = clean(payload?.eventKey);
  const companyId = clean(payload?.companyId);
  return eventKey ? `${eventKey}_deal_${companyId}` : `deal_${companyId}`;
}

// Mirrors the bot helper `safePathSegment`.
const safePathSegment = (value) => {
  const text = clean(value).replace(/[^\w.-]+/g, "-").replace(/-+/g, "-")
    .replace(/^-|-$/g, "").slice(0, 80);
  return text || "item";
};

// Mirrors the bot helper `sitePredealId`: `site_<eventKey>_<companyId>`.
export function exhibitionSitePreleadId(eventKey, companyId) {
  const key = clean(eventKey) || "event";
  const id = clean(companyId) || "company";
  return `site_${safePathSegment(key)}_${safePathSegment(id)}`.toLowerCase();
}

// The company id the published catalog sends in its notes and rejection calls.
// The catalog page builds it as `<eventKey>-<card index>`, which is the id the
// published company JSON carries in its `id` field.
export function exhibitionNotesCompanyId({ eventKey, cardIndex } = {}) {
  const key = clean(eventKey).toLowerCase();
  const index = clean(cardIndex);
  if (!key || !index) return "";
  return `${key}-${index}`;
}

// The company id the bot derives from the published deal payload, `c<catalog index>`.
export function exhibitionDealCompanyId(company) {
  const source = company && typeof company === "object" ? company : {};
  const payload = clean(source.deal_payload) || clean(source.telegramPayload) ||
    clean(source.telegram_payload);
  const parts = exhibitionDealPayloadParts(payload);
  return parts ? parts.suffix : "";
}

// The company id the bot writes the deal marker under. The bot resolves the
// company in the published catalog JSON and uses the id that catalog publishes,
// so the marker lands in the same pre-lead record as the notes and the
// rejection state of the catalog page. The payload id is the fallback for a
// catalog that publishes no id.
export function exhibitionMarkerCompanyId(company) {
  const source = company && typeof company === "object" ? company : {};
  return clean(source.id) || exhibitionDealCompanyId(source);
}

// The two prelead keys the notes path and the Telegram deal path address for one
// company. They are equal only when the catalog addresses a company by the same id
// in both paths.
export function exhibitionPreleadIdPaths({ eventKey, company } = {}) {
  const source = company && typeof company === "object" ? company : {};
  const dealCompanyId = exhibitionDealCompanyId(source);
  const notesCompanyId = clean(source.id);
  const markerCompanyId = exhibitionMarkerCompanyId(source);
  const dealPreleadId = exhibitionSitePreleadId(eventKey, markerCompanyId);
  const notesPreleadId = exhibitionSitePreleadId(eventKey, notesCompanyId);
  return {
    dealCompanyId,
    notesCompanyId,
    markerCompanyId,
    dealPreleadId,
    notesPreleadId,
    same: Boolean(markerCompanyId) && Boolean(notesCompanyId) &&
      dealPreleadId === notesPreleadId
  };
}

export function exhibitionCardFields(card) {
  if (Array.isArray(card)) {
    return { name: clean(card[0]), stand: clean(card[1]) };
  }
  if (card && typeof card === "object") {
    return { name: clean(card.name), stand: clean(card.stand) };
  }
  return { name: "", stand: "" };
}

// Splits a published `deal_payload` into its event part and its company suffix.
export function exhibitionDealPayloadParts(payload) {
  const value = clean(payload);
  if (!value) return null;
  const marker = value.lastIndexOf("_deal_");
  if (marker >= 0) {
    return { eventPart: value.slice(0, marker), suffix: value.slice(marker + "_deal_".length) };
  }
  if (value.startsWith("deal_")) {
    return { eventPart: "", suffix: value.slice("deal_".length) };
  }
  return null;
}

export function validatePublishedExhibitionCatalog({ eventKey, catalog, cards } = {}) {
  const key = clean(eventKey).toLowerCase();
  const problems = [];
  const add = (index, code, detail) => problems.push({ index, code, detail });

  const companies = catalog && typeof catalog === "object" && Array.isArray(catalog.companies)
    ? catalog.companies
    : [];
  const hasCards = Array.isArray(cards);
  const seenIds = new Map();
  const seenPayloads = new Map();

  companies.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      add(index, "company_not_object", "companies[] entry is not a plain object");
      return;
    }
    if (clean(entry.eventKey) && clean(entry.eventKey).toLowerCase() !== key) {
      add(index, "event_key_mismatch",
        `eventKey ${clean(entry.eventKey)} != ${key}`);
    }

    const payload = clean(entry.deal_payload) || clean(entry.telegramPayload) ||
      clean(entry.telegram_payload);
    // The published payload carries the company index inside the exhibition catalog,
    // not the position of the company inside this enriched subset.
    let catalogIndex = null;
    if (!payload) {
      add(index, "deal_payload_missing", "no deal_payload, telegramPayload or telegram_payload");
    } else {
      if (!/^[A-Za-z0-9_-]+$/.test(payload)) {
        add(index, "deal_payload_not_url_safe", `payload ${payload} is not URL-safe`);
      }
      const parts = exhibitionDealPayloadParts(payload);
      if (!parts || !EXHIBITION_DEAL_PAYLOAD_PATTERN.test(payload)) {
        add(index, "deal_payload_format", `payload ${payload} does not match the bot payload format`);
      } else {
        if (parts.eventPart && parts.eventPart.toLowerCase() !== key) {
          add(index, "deal_payload_event_mismatch",
            `payload event ${parts.eventPart} != ${key}`);
        }
        const suffixIndex = /^c(\d+)$/.exec(parts.suffix);
        if (suffixIndex) catalogIndex = Number(suffixIndex[1]);
        else add(index, "deal_payload_suffix_unreadable",
          `payload ${payload} does not carry a c<index> company suffix`);
      }
      if (seenPayloads.has(payload)) {
        add(index, "duplicate_deal_payload",
          `payload ${payload} already used at index ${seenPayloads.get(payload)}`);
      } else {
        seenPayloads.set(payload, index);
      }
    }

    const companyId = clean(entry.id);
    if (companyId) {
      const expected = catalogIndex === null ? null : `${key}-${catalogIndex}`;
      if (expected !== null) {
        if (companyId !== expected) {
          add(index, "company_id_mismatch", `id ${companyId} != ${expected}`);
        }
      } else if (!new RegExp(`^${key}-\\d+$`).test(companyId)) {
        add(index, "company_id_mismatch", `id ${companyId} is not <eventKey>-<index>`);
      }
      if (seenIds.has(companyId)) {
        add(index, "duplicate_company_id",
          `id ${companyId} already used at index ${seenIds.get(companyId)}`);
      } else {
        seenIds.set(companyId, index);
      }
    }

    if (!hasCards) return;
    if (catalogIndex === null) return;
    if (catalogIndex >= cards.length) {
      add(index, "card_index_out_of_range",
        `cards has ${cards.length} entries, index ${catalogIndex} is out of range`);
      return;
    }
    const card = exhibitionCardFields(cards[catalogIndex]);
    if (card.name !== clean(entry.name)) {
      add(index, "card_name_mismatch",
        `card name ${card.name} != catalog name ${clean(entry.name)}`);
    }
    if (card.stand !== clean(entry.stand)) {
      add(index, "card_stand_mismatch",
        `card stand ${card.stand} != catalog stand ${clean(entry.stand)}`);
    }
  });

  return { eventKey: key, companyCount: companies.length, problems };
}
