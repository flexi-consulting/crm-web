import test from "node:test";
import assert from "node:assert/strict";
import { exhibitionCardFields, exhibitionCompaniesUrlByEvent,
  exhibitionDealPayloadFor, exhibitionDealPayloadParts,
  parseExhibitionBindingJson, parseExhibitionDealPayload,
  resolveExhibitionDealCompany,
  validatePublishedExhibitionCatalog } from "../src/exhibition-telegram-deal-payload.js";

const eventKey = "invented-expo-2026";
const binding = JSON.stringify({
  "invented-expo-2026": "https://invented-expo-2026.example.invalid/telegram_companies.json",
  "older-expo-2025": "https://older-expo-2025.example.invalid/telegram_companies.json"
});

test("payload parsing mirrors the bot start payload grammar", () => {
  assert.deepEqual(parseExhibitionDealPayload("invented-expo-2026_deal_c3"), {
    raw: "invented-expo-2026_deal_c3", eventKey: "invented-expo-2026",
    companyId: "c3", matched: true
  });
  assert.deepEqual(parseExhibitionDealPayload("  deal_c12  "), {
    raw: "deal_c12", eventKey: "", companyId: "c12", matched: true
  });
  // The bot lowercases the event key but keeps the company id as written.
  assert.equal(parseExhibitionDealPayload("Invented-Expo-2026_deal_c3").eventKey,
    "invented-expo-2026");
  assert.equal(parseExhibitionDealPayload("invented-expo-2026_deal_c3").companyId, "c3");
});

test("payload parsing rejects shapes the bot cannot read", () => {
  for (const value of ["", "deal", "deal_", "_deal_c3", "invented_expo_deal_c3",
    "invented-expo-2026_deal_c3_extra", "invented-expo-2026_deal_c-3",
    "invented-expo-2026_note_c3", null, undefined]) {
    assert.equal(parseExhibitionDealPayload(value).matched, false,
      `expected ${JSON.stringify(value)} to be rejected`);
  }
});

test("binding lookup is case-insensitive and never guesses an event", () => {
  assert.equal(exhibitionCompaniesUrlByEvent(binding, "invented-expo-2026"),
    "https://invented-expo-2026.example.invalid/telegram_companies.json");
  assert.equal(exhibitionCompaniesUrlByEvent(binding, "INVENTED-EXPO-2026"),
    "https://invented-expo-2026.example.invalid/telegram_companies.json");
  assert.equal(exhibitionCompaniesUrlByEvent(binding, "missing-expo-2026"), "");
  assert.equal(exhibitionCompaniesUrlByEvent(binding, ""), "");
  assert.equal(exhibitionCompaniesUrlByEvent("not json", "invented-expo-2026"), "");
  assert.deepEqual(parseExhibitionBindingJson("not json"), {});
  assert.deepEqual(parseExhibitionBindingJson({ a: 1 }), { a: 1 });
});

test("company resolution prefers the published deal payload", () => {
  const companies = [
    { id: "invented-expo-2026-0", deal_payload: "deal_c0", name: "Alpha" },
    { id: "invented-expo-2026-1", deal_payload: "deal_c1", name: "Beta" }
  ];
  const resolved = resolveExhibitionDealCompany({ companies, eventKey, companyId: "c1" });
  assert.equal(resolved.matchedBy, "deal_payload");
  assert.equal(resolved.company.name, "Beta");
});

test("company resolution accepts an event qualified published payload", () => {
  const companies = [
    { id: "6a216c44abda71a4e0208d26",
      deal_payload: "invented-expo-2026_deal_6a216c44abda71a4e0208d26", name: "Gamma" }
  ];
  const resolved = resolveExhibitionDealCompany({
    companies, eventKey, companyId: "6a216c44abda71a4e0208d26"
  });
  assert.equal(resolved.matchedBy, "deal_payload");
  assert.equal(resolved.company.name, "Gamma");
});

test("company resolution falls back to the company id and then to the index", () => {
  const companies = [
    { id: "stand-b1", name: "Delta" },
    { id: "stand-b2", name: "Epsilon" }
  ];
  const byId = resolveExhibitionDealCompany({ companies, eventKey, companyId: "stand-b2" });
  assert.equal(byId.matchedBy, "company_id");
  assert.equal(byId.company.name, "Epsilon");
  const byIndex = resolveExhibitionDealCompany({ companies, eventKey, companyId: "1" });
  assert.equal(byIndex.matchedBy, "index");
  assert.equal(byIndex.company.name, "Epsilon");
  const missing = resolveExhibitionDealCompany({ companies, eventKey, companyId: "c9" });
  assert.equal(missing.matchedBy, null);
  assert.equal(missing.company, null);
  const invalid = resolveExhibitionDealCompany({ companies: "nope", eventKey, companyId: "c9" });
  assert.equal(invalid.company, null);
});

test("the bot reads camel and snake payload aliases but not deal_payload", () => {
  const payload = parseExhibitionDealPayload("invented-expo-2026_deal_c3");
  assert.equal(exhibitionDealPayloadFor({ dealPayload: "custom_c9" }, payload), "custom_c9");
  assert.equal(exhibitionDealPayloadFor({ telegramPayload: "custom_c9" }, payload), "custom_c9");
  assert.equal(exhibitionDealPayloadFor({ telegram_payload: "custom_c9" }, payload), "custom_c9");
  // A published catalog stores `deal_payload`, so the bot rebuilds the event qualified payload.
  assert.equal(exhibitionDealPayloadFor({ deal_payload: "deal_c3" }, payload),
    "invented-expo-2026_deal_c3");
  assert.equal(exhibitionDealPayloadFor({}, { eventKey: "", companyId: "c3" }), "deal_c3");
});

test("published catalog validation accepts a consistent catalog", () => {
  const cards = [["Alpha", "A1", "Россия"], ["Beta", "B2", "Россия"]];
  const catalog = { companies: [
    { eventKey, id: `${eventKey}-0`, deal_payload: "deal_c0", name: "Alpha", stand: "A1" },
    { eventKey, id: `${eventKey}-1`, deal_payload: "deal_c1", name: "Beta", stand: "B2" }
  ] };
  const result = validatePublishedExhibitionCatalog({ eventKey, catalog, cards });
  assert.deepEqual(result.problems, []);
  assert.equal(result.companyCount, 2);
});

test("published catalog validation reports every broken rule", () => {
  const cards = [["Alpha", "A1", "Россия"], ["Beta", "B2", "Россия"]];
  const catalog = { companies: [
    { eventKey: "other-expo-2026", id: "wrong-id", deal_payload: "not safe!",
      name: "Wrong", stand: "Z9" },
    "not an object",
    { eventKey, id: `${eventKey}-2`, deal_payload: "deal_c1", name: "Beta", stand: "B2" }
  ] };
  const result = validatePublishedExhibitionCatalog({ eventKey, catalog, cards });
  const codes = result.problems.map((problem) => `${problem.index}:${problem.code}`);
  assert.deepEqual(codes, [
    "0:event_key_mismatch",
    "0:deal_payload_not_url_safe",
    "0:deal_payload_format",
    "0:company_id_mismatch",
    "1:company_not_object",
    "2:company_id_mismatch"
  ]);
});

test("published catalog validation reads the catalog index from the payload", () => {
  // The payload carries the index inside the exhibition catalog, not the position of
  // the company inside the enriched subset.
  const cards = [["Alpha", "A1", "Россия"], ["Beta", "B2", "Россия"], ["Gamma", "C3", "Россия"]];
  const catalog = { companies: [
    { eventKey, id: `${eventKey}-2`, deal_payload: "deal_c2", name: "Gamma", stand: "C3" }
  ] };
  const result = validatePublishedExhibitionCatalog({ eventKey, catalog, cards });
  assert.deepEqual(result.problems, []);
  assert.equal(result.companyCount, 1);
});

test("published catalog validation reports an unreadable payload suffix", () => {
  const catalog = { companies: [
    { eventKey, id: `${eventKey}-0`, deal_payload: "deal_company", name: "Alpha", stand: "A1" }
  ] };
  const result = validatePublishedExhibitionCatalog({ eventKey, catalog });
  const codes = result.problems.map((problem) => `${problem.index}:${problem.code}`);
  assert.deepEqual(codes, ["0:deal_payload_suffix_unreadable"]);
});

test("published catalog validation reports duplicates and missing payloads", () => {
  const catalog = { companies: [
    { eventKey, id: `${eventKey}-0`, deal_payload: "deal_c0", name: "Alpha", stand: "A1" },
    { eventKey, id: `${eventKey}-0`, deal_payload: "deal_c0", name: "Alpha", stand: "A1" },
    { eventKey, id: `${eventKey}-2`, name: "Gamma", stand: "C3" }
  ] };
  const result = validatePublishedExhibitionCatalog({ eventKey, catalog });
  const codes = result.problems.map((problem) => `${problem.index}:${problem.code}`);
  assert.deepEqual(codes, [
    "1:duplicate_deal_payload",
    "1:duplicate_company_id",
    "2:deal_payload_missing"
  ]);
});

test("published catalog validation skips card rules without cards", () => {
  const catalog = { companies: [
    { eventKey, id: `${eventKey}-0`, deal_payload: "deal_c0", name: "Alpha", stand: "A1" }
  ] };
  const result = validatePublishedExhibitionCatalog({ eventKey, catalog });
  assert.deepEqual(result.problems, []);
});

test("published payload parts expose the event prefix and company suffix", () => {
  assert.deepEqual(exhibitionDealPayloadParts("deal_c3"), { eventPart: "", suffix: "c3" });
  assert.deepEqual(exhibitionDealPayloadParts("invented-expo-2026_deal_c3"),
    { eventPart: "invented-expo-2026", suffix: "c3" });
  assert.equal(exhibitionDealPayloadParts("nope"), null);
  assert.equal(exhibitionDealPayloadParts(""), null);
});

test("card fields accept both published card shapes", () => {
  assert.deepEqual(exhibitionCardFields(["Alpha", "A1", "Россия"]),
    { name: "Alpha", stand: "A1" });
  assert.deepEqual(exhibitionCardFields({ name: "Alpha", stand: "A1" }),
    { name: "Alpha", stand: "A1" });
  assert.deepEqual(exhibitionCardFields(null), { name: "", stand: "" });
});
