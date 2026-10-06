# Private S-03/S-04 note recovery dry run

The initial private correlation report accounts for all 152 legacy site preleads and retains the old D1 export separately. Its first dry run has 152 `pending_review` records, zero mapped or held records, 81 preleads without catalog row evidence, 43 `site_deal` messages on those 81, nine historical-only preleads with five deal messages, and one current plus 281 historical catalog rows without a usable ID. This is an inventory of decisions still needed; no identity decision was inferred from a name, note key or old path.

`src/legacy-note-recovery-plan.js` turns the private correlation report and explicit decisions into an offline plan. It verifies independent SHA-256 receipts for the current catalog manifest, historical manifest and notes SQL. Every prelead remains `pending_review` until a decision is supplied. The only decisions are:

- `hold`: keep the old note and deal link detached, with a review reference and reason.
- `link_current`: name one exact current catalog source SHA-256, source path, event, row and old company ID; supply a reviewed trusted profile binding and review reference. A historical-only candidate cannot use this decision. The result is `mapped_for_local_review`, never a live write. If an old deal message exists, the plan also records `verify_existing_provider_deal`; it cannot turn an old ID into a confirmed app-owned link.

`node scripts/legacy-note-recovery-plan.mjs REPORT_JSON INDEPENDENT_RECEIPTS_JSON NEW_PRIVATE_OUTPUT_JSON [DECISIONS_JSON TRUSTED_CATALOGS_JSON]` writes the full plan to a new owner-only file outside Git and prints aggregate counts only. The independent receipts file must contain `current`, `historical`, `notesSql`, and `correlationReport` SHA-256 digests; the last verifies the exact report bytes before parsing. With the first three arguments the CLI produces the pending skeleton. With both optional files it requires an explicit decision for every prelead; missing, duplicate, extra or stale decisions fail. The input files must be owner-only and outside Git, and the output directory must exclude group/other access. The command contains no D1, Cloudflare or Weeek call.

An invented decision and trusted catalog entry:

```json
{"preleadId":"site_demo-expo_sample001","kind":"link_current","candidate":{"sourceSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","sourcePath":"demo/current/index.html","eventKey":"demo-expo","rowIndex":0,"legacyCompanyId":"SAMPLE001"},"profileRef":"demo-profile-a","reviewRef":"review-example-001"}
```

```json
{"sourceSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","sourcePath":"demo/current/index.html","eventKey":"demo-expo","profileRef":"demo-profile-a"}
```

These structures are dry-run assertions, not trusted approval receipts. Before any real app-owned D1 import, a reviewer must settle the 81 missing links and every ambiguous or historical-only case, bind old event/company IDs to the user's trusted profile, reconcile writes after the initial 09:19 MSK notes export, and check old browser links. Preserve the old SQL, original message order and deal IDs for every held or unresolved record. A later local restore must verify the mapped note timeline and existing provider deals without creating another deal.
