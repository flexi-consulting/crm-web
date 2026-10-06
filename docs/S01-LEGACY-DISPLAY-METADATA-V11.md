# S-01 legacy catalog display metadata v1.1

Status: proposed app-owned contract, synthetic fixtures only. This schema is not yet the active API and does not approve publication or private legacy import.

## Purpose

Preserve the source-backed display facts required by the existing exhibition catalog: category, short description, market segment, revenue/profit amounts and their source years. Search, filters and cards consume the same canonical normalized company record; the browser must not receive old HTML rows directly.

## Field ownership and semantics

| Field | Location | Meaning |
|---|---|---|
| `source.category` | source | Catalog category text (`cat`); display/search only, not independently verified |
| `source.description` | source | Legacy description (`b`); escaped display/search text, never qualification evidence by itself |
| `source.segment` | source | Legacy segment (`seg`); display only until a reviewed rule defines its use |
| `enrichment.revenueRub` | enrichment | Whole RUB; null means unavailable/absent, zero is a real value |
| `enrichment.revenueYear` | enrichment | Year corresponding to revenue; null if source omitted it |
| `enrichment.profitRub` | enrichment | Whole RUB; negative values are losses; null means unavailable/absent |
| `enrichment.profitYear` | enrichment | Year corresponding to profit; null if source omitted it |

Legacy monetary values in the reviewed 2026 catalog are expressed in RUB millions and may be fractional. Conversion to the proposed whole-RUB storage unit is `Math.round(value * 1_000_000)`; reject non-finite/unsafe values. Keep `rev/ry` and `prof/py` source provenance at field-level in the eventual migration decision receipt; these display values do not become current Registry enrichment merely because a legacy catalog contained them.

The established filters are: revenue `<100`, `100..1500` inclusive, `>1500`; profit `<0`, `0..30`, `30..200`, `>=200`. A bounded financial filter excludes null. Search is case-insensitive over name, category and country. `ru===1` is represented by `country="RU"` only when the legacy row has no more specific `country`; other country labels are preserved as source text.

## Compatibility gates

- Introduce a new artifact schema version; do not silently add these properties to v1.0.
- Validate source strings and URLs, escape every rendered field, and keep PII allowlist unchanged.
- Update report counts and API response contract as one versioned change.
- Golden tests compare old synthetic-filter semantics against the app-owned domain query and browser controls at every boundary, including null, zero and negative profit.
- Legacy import requires an explicit reviewed decision for each added source field and its year/unit. Missing fields remain null; no inferred year or amount.
- Existing MCP capability exposes only catalog reads required by agent journeys; filter behavior stays in the app/API and does not require an MCP tool per filter.

## Not yet covered

This proposal does not define target qualification from category/segment or financials, registry provenance, publication, existing user state, or ownership of live catalogs. Those require separate accepted decisions.
