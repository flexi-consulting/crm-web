import test from "node:test";
import assert from "node:assert/strict";
import { renderBuiltCatalogBrowser, browserHeaders } from "../src/built-catalog-browser.js";

const buildId = `build-${"a".repeat(24)}`;
const companyId = `co-${"b".repeat(20)}`;
const participant = { id: companyId, name: '<img src=x onerror="alert(1)">',
  qualification: { classification: "near_target", reason: "source <unverified>" },
  source: { country: "RU", booth: "A-01", href: "javascript:alert(1)" },
  enrichment: { inn: null, ogrn: null, revenueRub: null, status: "unavailable",
    website: "https://example.invalid/company?a=1&b=2", provenance: { provider: "fixture" } },
  registry: { status: "unknown" } };
const data = { buildId, exhibitionId: "demo-expo-001", sourceRevision: "revision-one", items: [participant] };

test("list and card show the same stable identity, escape source text and reject unsafe links", () => {
  const list = renderBuiltCatalogBrowser(data, { query: 'a"<b>', classification: "near_target" });
  const card = renderBuiltCatalogBrowser(data, { companyId });
  assert.match(list, new RegExp(`/catalogs/${buildId}/participants/${companyId}`));
  assert.ok(list.includes('value="a&quot;&lt;b&gt;"'));
  assert.ok(!list.includes("<img"));
  assert.ok(card.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"));
  assert.ok(card.includes("Неизвестны"));
  assert.ok(card.includes("source &lt;unverified&gt;"));
  assert.ok(!card.includes("javascript:"));
  assert.ok(card.includes("https://example.invalid/company?a=1&amp;b=2"));
  assert.ok(!card.includes("Создать сделку"));
  assert.match(browserHeaders["content-security-policy"], /default-src 'none'/);
  assert.match(browserHeaders["cache-control"], /no-store/);
});
