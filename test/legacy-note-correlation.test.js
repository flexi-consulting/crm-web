import test from "node:test";
import assert from "node:assert/strict";
import { classifyHistoricalExArtifact, correlateLegacySiteNotes,
  legacySitePredealKey, summarizeLegacyNoteCorrelation } from "../src/legacy-note-correlation.js";

const sha = (char) => char.repeat(64);
const invented = {
  currentCatalogs: [{ profileRef: "demo-profile-a", eventKey: "invented-expo-2026",
    sourceSha256: sha("a"), entries: [{ id: "LANG001" },
      { id: "AB C-1" }, { id: "AB-C-1" }] }],
  historicalCatalogs: [{ profileRef: "demo-profile-b", eventKey: "older_expo",
    sourceSha256: sha("b"), entries: [{ id: "OLD001" }] },
  { profileRef: "demo-profile-b", eventKey: "older_expo",
    sourceSha256: sha("c"), entries: [{ id: "OLD001" }] }]
};

test("legacy bot key normalization exposes ID collisions without binding notes", () => {
  assert.equal(legacySitePredealKey("invented-expo-2026", "LANG001"),
    "site_invented-expo-2026_lang001");
  assert.equal(legacySitePredealKey("invented-expo-2026", "AB C-1"),
    legacySitePredealKey("invented-expo-2026", "AB-C-1"));
  const ids = ["site_invented-expo-2026_lang001", "site_invented-expo-2026_ab-c-1",
    "site_older_expo_old001", "site_invented-expo-2026_missing",
    "site_never-published_abc", "unexpected-key"];
  const results = correlateLegacySiteNotes({ ...invented, preleadIds: ids });
  assert.deepEqual(results.map((item) => item.status), [
    "current_unique_evidence", "current_ambiguous_quarantine",
    "historical_only_quarantine", "known_event_missing_company_quarantine",
    "unknown_event_quarantine", "invalid_note_key_quarantine"
  ]);
  assert.deepEqual(results[0].currentCandidates.map((item) => item.rowIndex), [0]);
  assert.deepEqual(results[1].currentCandidates.map((item) => item.rowIndex), [1, 2]);
  assert.equal(results[2].currentCandidates.length, 0);
  assert.deepEqual(results[2].historicalCandidates.map((item) => item.sourceSha256),
    [sha("b"), sha("c")]);
  assert.equal(results[3].currentCandidates.length, 0);
  assert.equal(results[4].historicalCandidates.length, 0);
  assert.deepEqual(summarizeLegacyNoteCorrelation(results), {
    current_unique_evidence: 1, current_ambiguous_quarantine: 1,
    historical_only_quarantine: 1, known_event_missing_company_quarantine: 1,
    unknown_event_quarantine: 1, invalid_note_key_quarantine: 1
  });
});

test("historical HTML keeps byte revision and quarantines unrendered templates", () => {
  const sourcePath = "invented-profile/projects/invented-expo/deploy/old/index.html";
  const html = Buffer.from(`<script>const EX = [{"id":"OLD001","n":"Invented Maker"}];\nconst EVENT_KEY = 'old-expo';</script>`);
  const parsed = classifyHistoricalExArtifact({ bytes: html, sourcePath });
  assert.equal(parsed.status, "catalog_evidence");
  assert.equal(parsed.eventKey, "old-expo");
  assert.deepEqual(parsed.entries.map((item) => item.id), ["OLD001"]);
  assert.equal(parsed.sourceRevision, `legacy-html-sha256:${parsed.sourceSha256}`);
  assert.deepEqual(classifyHistoricalExArtifact({ bytes: html, sourcePath }), parsed);
  assert.notEqual(classifyHistoricalExArtifact({ bytes: Buffer.concat([html, Buffer.from(" ")]),
    sourcePath }).sourceRevision, parsed.sourceRevision);

  const template = classifyHistoricalExArtifact({ bytes: Buffer.from(
    `<script>const EX = {{EX_JSON}}; const EVENT_KEY = '{{EVENT_KEY}}';</script>`),
  sourcePath: "invented-profile/templates/index.html" });
  assert.equal(template.status, "template_quarantine");
  assert.equal("entries" in template, false);
  assert.equal(classifyHistoricalExArtifact({ bytes: Buffer.from("<script>const EX = unknown;</script>"),
    sourcePath }).status, "unparsed_quarantine");
});

test("invalid evidence fails closed before correlation", () => {
  assert.throws(() => correlateLegacySiteNotes({ currentCatalogs: [{ eventKey: "demo",
    sourceSha256: "bad", entries: [] }], preleadIds: [] }), /legacy_catalog_invalid/);
  assert.throws(() => correlateLegacySiteNotes({ currentCatalogs: [],
    preleadIds: [null] }), /legacy_prelead_ids_invalid/);
});
