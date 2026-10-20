#!/usr/bin/env node
// Read-only probe for the published exhibition Telegram deal catalogs.
//
// It re-reads the published catalog project, checks every published company JSON
// against the exhibition card list, and replays the legacy Telegram deal bot's
// payload grammar and company resolution for every published company.
//
// The probe never writes: it only issues GET requests to the published catalog and
// reads an optional local copy of the live worker binding.
//
//   EXHIBITION_CATALOG_ORIGIN            catalog origin (default: the published review catalog)
//   TELEGRAM_DEAL_EVENT_URLS_JSON        live worker binding value, as JSON text
//   TELEGRAM_DEAL_EVENT_URLS_JSON_FILE   path to a file holding the live binding value
//   VERIFY_STRICT_PRELEAD_IDS            1 fails the probe when the notes path and the
//                                        deal path address different prelead keys
//
// Exit code 1 means at least one check failed.

import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { exhibitionCompaniesUrlByEvent, exhibitionDealCompanyId,
  exhibitionPreleadIdPaths, exhibitionSitePreleadId, parseExhibitionDealPayload,
  resolveExhibitionDealCompany,
  validatePublishedExhibitionCatalog } from "../src/exhibition-telegram-deal-payload.js";

const origin = (process.env.EXHIBITION_CATALOG_ORIGIN ??
  "https://exhibition-catalog-review.pages.dev").replace(/\/$/, "");
const mappingUrl = `${origin}/TELEGRAM_DEAL_EVENT_URLS_JSON.example.json`;
const cardsUrl = `${origin}/data.js`;

const failures = [];
const note = (message) => failures.push(message);
const cleanId = (company) => String(company?.id ?? "").trim();

const getText = async (url) => {
  const response = await fetch(url, { headers: { Accept: "application/json, text/javascript" } });
  return { status: response.status, contentType: response.headers.get("content-type") ?? "",
    text: await response.text() };
};

// data.js is a browser script, not a JSON document, so it is evaluated in a bare context.
const readCards = async () => {
  const { status, text } = await getText(cardsUrl);
  if (status !== 200) throw new Error(`cards_unavailable:${status}`);
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(text, context, { timeout: 5000 });
  const exhibitions = context.window?.EXHIBITIONS;
  if (!Array.isArray(exhibitions)) throw new Error("cards_shape_unexpected");
  return new Map(exhibitions.map((item) => [String(item.id).toLowerCase(), item]));
};

const readLiveBinding = async () => {
  if (process.env.TELEGRAM_DEAL_EVENT_URLS_JSON_FILE) {
    return readFile(process.env.TELEGRAM_DEAL_EVENT_URLS_JSON_FILE, "utf8");
  }
  if (process.env.TELEGRAM_DEAL_EVENT_URLS_JSON) return process.env.TELEGRAM_DEAL_EVENT_URLS_JSON;
  return null;
};

const mappingResponse = await getText(mappingUrl);
if (mappingResponse.status !== 200) {
  throw new Error(`mapping_unavailable:${mappingResponse.status}`);
}
let mapping;
try {
  mapping = JSON.parse(mappingResponse.text);
} catch {
  throw new Error("mapping_not_json");
}
if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
  throw new Error("mapping_shape_unexpected");
}

const cards = await readCards();
const liveBinding = await readLiveBinding();
const rows = [];

for (const [eventKey, url] of Object.entries(mapping)) {
  const key = String(eventKey).toLowerCase();
  const row = { eventKey: key, url, status: null, contentType: "", companyCount: 0,
    cardCount: cards.get(key)?.companies?.length ?? null, problems: [], resolved: 0,
    unresolved: 0, bindingResolved: null, preleadDivergence: 0, preleadPaths: [],
    notesPath: null };

  const response = await getText(url);
  row.status = response.status;
  row.contentType = response.contentType;
  if (response.status !== 200) {
    row.problems.push(`status_${response.status}`);
    note(`${key}: published JSON returned HTTP ${response.status}`);
    rows.push(row);
    continue;
  }
  if (!/application\/json/.test(response.contentType)) {
    row.problems.push("content_type");
    note(`${key}: published JSON is not application/json (${response.contentType})`);
  }

  let catalog;
  try {
    catalog = JSON.parse(response.text);
  } catch {
    row.problems.push("not_json");
    note(`${key}: published JSON is not valid JSON`);
    rows.push(row);
    continue;
  }
  if (!catalog || typeof catalog !== "object" || !Array.isArray(catalog.companies)) {
    row.problems.push("no_companies");
    note(`${key}: published JSON has no companies array`);
    rows.push(row);
    continue;
  }
  row.companyCount = catalog.companies.length;
  row.hasMeta = Boolean(catalog.meta && typeof catalog.meta === "object");

  const validation = validatePublishedExhibitionCatalog({
    eventKey: key, catalog, cards: cards.get(key)?.companies
  });
  row.problems = validation.problems.map((problem) => `${problem.index}:${problem.code}`);
  for (const problem of validation.problems) {
    note(`${key}: ${problem.code} at index ${problem.index} (${problem.detail})`);
  }

  // Replay the bot payload grammar and company resolution for every published company.
  // The catalog page links a company with `<eventKey>_deal_c<catalog index>`, so the
  // replay starts from the published payload instead of the enriched subset position.
  for (const company of catalog.companies) {
    const paths = exhibitionPreleadIdPaths({ eventKey: key, company });
    row.preleadPaths.push({ id: cleanId(company), ...paths });
    if (!paths.same) row.preleadDivergence += 1;
    const published = String(company.deal_payload ?? company.telegramPayload ??
      company.telegram_payload ?? "").trim();
    if (!published) {
      note(`${key}: company ${cleanId(company)} publishes no deal payload`);
      row.unresolved += 1;
      continue;
    }
    const startPayload = published.startsWith("deal_") ? `${key}_${published}` : published;
    const payload = parseExhibitionDealPayload(startPayload);
    if (!payload.matched) {
      note(`${key}: payload ${startPayload} is not readable by the bot`);
      row.unresolved += 1;
      continue;
    }
    const resolved = resolveExhibitionDealCompany({
      companies: catalog.companies, eventKey: payload.eventKey, companyId: payload.companyId
    });
    if (!resolved.company) {
      note(`${key}: payload ${startPayload} resolves to no company`);
      row.unresolved += 1;
      continue;
    }
    row.resolved += 1;
    if (cleanId(resolved.company) !== cleanId(company)) {
      note(`${key}: payload ${startPayload} resolves to ${cleanId(resolved.company)} instead of ${cleanId(company)}`);
    }
  }

  if (liveBinding !== null) {
    const bound = exhibitionCompaniesUrlByEvent(liveBinding, key);
    row.bindingResolved = bound;
    if (bound !== url) {
      row.problems.push("binding_mismatch");
      note(`${key}: live binding resolves to ${bound || "nothing"} instead of ${url}`);
    }
  }

  // Read-only probe of the published notes endpoint. The catalog page posts a note or
  // a rejection for a company under its internal id, the bot answers with the prelead
  // key of that id, and the Telegram deal path writes its marker under the payload id.
  const probeCompany = catalog.companies[0];
  if (probeCompany) {
    const companyId = cleanId(probeCompany);
    const notesUrl = `${origin}/api/notes?eventKey=${encodeURIComponent(key)}` +
      `&companyId=${encodeURIComponent(companyId)}`;
    const notesResponse = await getText(notesUrl);
    row.notesPath = { url: notesUrl, status: notesResponse.status, companyId,
      preleadId: null, dealPreleadId: exhibitionSitePreleadId(key, exhibitionDealCompanyId(probeCompany)),
      matchesDealPreleadId: null };
    if (notesResponse.status === 200) {
      try {
        const notes = JSON.parse(notesResponse.text);
        row.notesPath.preleadId = notes.preleadId ?? null;
        row.notesPath.matchesDealPreleadId = row.notesPath.preleadId ===
          row.notesPath.dealPreleadId;
      } catch {
        row.notesPath.error = "not_json";
      }
    }
  }

  rows.push(row);
}

// The prelead id divergence is a known open finding of the published catalog, so it is
// reported by default and only fails the probe when it is asked for explicitly.
const strictPreleadIds = ["1", "true", "yes"].includes(
  String(process.env.VERIFY_STRICT_PRELEAD_IDS ?? "").toLowerCase());
if (strictPreleadIds) {
  for (const row of rows) {
    if (row.preleadDivergence > 0) {
      note(`${row.eventKey}: ${row.preleadDivergence} companies address a different prelead in the notes path and in the deal path`);
    }
  }
}

const report = {
  origin, mappingUrl, cardsUrl,
  liveBindingChecked: liveBinding !== null,
  strictPreleadIds,
  preleadDivergenceTotal: rows.reduce((sum, row) => sum + row.preleadDivergence, 0),
  events: rows,
  failures
};

console.log(JSON.stringify(report, null, 2));
process.exit(failures.length ? 1 : 0);
