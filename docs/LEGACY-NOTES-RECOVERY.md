# Legacy site note and deal-link recovery

The site notes endpoint and the Telegram deal bot share a legacy D1 database. Its site prelead key is `site_<normalized eventKey>_<normalized companyId>`, where each segment is trimmed, replaces runs of characters outside ASCII letters, digits, underscore, dot and hyphen with `-`, collapses dashes, truncates to 80 characters, and the whole key is lowercased. Distinct catalog IDs can therefore produce the same note key. A note key also lacks a trusted profile reference.

## Private source inventory, 2026-10-06

The frozen old source yielded 19 current deployed catalog HTML files (4,296 rows) and 21 named source JSON files. A recursive read-only search found 74 additional HTML files with `const EX` outside those layouts. All 74 were byte-captured in a separate owner-only archive with a matching source/local manifest receipt. Of these, 43 contain parseable JSON-array catalogs (5,903 rows); the other 31 contain the literal `{{EX_JSON}}` placeholder and are unrendered templates, not a second catalog data format. Template bytes remain quarantined. One current row and 281 historical rows lack a usable string ID; the private correlation report records their source revision and row index separately. Neither archive nor its original paths, IDs or contents is committed.

Correlating the private D1 export's 152 site preleads against the current HTML with the exact old bot key function yielded:

| Evidence | Preleads |
| --- | ---: |
| One current catalog row | 59 |
| More than one current row for the same normalized key | 3 |
| No current row | 90 |

Of the 90 without a current row, 55 have an event key absent from the 19 current catalogs, and 35 refer to a current event but lack a matching company key. Four of those 35 keys appear in a source JSON file in the same project scope; source presence alone does not identify a published card. The 43 historical array catalogs provide row evidence for nine of the 90; all nine occur in more than one historical file or revision. Eighty-one remain without catalog row evidence: 35 with a known current event and 46 without a known catalog event. Of 51 old `site_deal` messages with a deal ID, three have unique current-row evidence, five have historical-only evidence, and 43 lack row evidence. A private owner-only report records all 152 preleads, source receipts, candidate revisions and row-level identity quarantine. These counts are acceptance baselines for the private recovery report, not import instructions.

## Offline correlation contract

`src/legacy-note-correlation.js` computes the legacy key, classifies a historical HTML artifact by exact byte SHA-256 revision, and correlates prelead IDs with explicit current and historical catalog snapshots. It reports current unique evidence, current ambiguity, historical-only evidence, known event with missing company, unknown event, or invalid key. Missing/nonstring row IDs are returned as row-level quarantine with source provenance; they are never silently indexed. The literal template placeholder and unparseable HTML are quarantined without entries. It does not read live D1, infer profile ownership, import notes, or write a deal. Invented golden tests cover normalization collisions, repeated historical revisions, missing links and template bytes.

Before restoring S-03 notes or S-04 deal links, create a private reviewed map for every prelead. The map must state the trusted profile, event, exact catalog source SHA-256/revision and row identity, or an explicit orphan disposition. A historical match is evidence only: repeated files may describe different versions of a card under one key. Preserve the original prelead and message bytes and old links for orphan/ambiguous cases; never choose a current row by name or normalized key alone. Re-export or reconcile D1 changes after the initial 09:19 MSK snapshot, verify message order and deal-link state, then test the mapped restore against app-owned local D1 and old browser URLs before any route cutover. No real note or deal-link restore has occurred.
