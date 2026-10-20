# Exhibition Telegram deal catalog

This note records how the published exhibition catalogs are connected to the legacy
Telegram deal bot, how the connection was verified, and what is still open.

The bot is the deployed `flexi-telegram-deal-bot` Worker. It reads one binding for
this integration, `TELEGRAM_DEAL_EVENT_URLS_JSON`, and it is the only consumer of
that binding in the bot source (`rosupackCompaniesUrlByEvent`). Nothing else in the
bot, and nothing in the CRM application, reads it.

## Live binding

`TELEGRAM_DEAL_EVENT_URLS_JSON` maps an exhibition event key to the published JSON
that lists the enriched companies of that exhibition. On 2026-10-20 the binding was
extended with the seven catalogs of the published review catalog, so it now holds
19 event keys: the 12 keys that were already bound, plus the 7 below.

| Event key | Published JSON |
|---|---|
| `heatpower2026` | `https://exhibition-catalog-review.pages.dev/heatpower/telegram_companies.json` |
| `expocoating2026` | `https://exhibition-catalog-review.pages.dev/expocoating/telegram_companies.json` |
| `testingcontrol2026` | `https://exhibition-catalog-review.pages.dev/testing-control/telegram_companies.json` |
| `ndtrussia2026` | `https://exhibition-catalog-review.pages.dev/ndt-russia/telegram_companies.json` |
| `pcvexpo2026` | `https://exhibition-catalog-review.pages.dev/pcvexpo/telegram_companies.json` |
| `fasttec2026` | `https://exhibition-catalog-review.pages.dev/fasttec/telegram_companies.json` |
| `rds2026` | `https://exhibition-catalog-review.pages.dev/rds/telegram_companies.json` |

The mapping is the one published by the catalog project itself in
`TELEGRAM_DEAL_EVENT_URLS_JSON.example.json`.

### Updating the binding

`PATCH /accounts/{account_id}/workers/scripts/{script_name}/settings` **replaces**
the binding list. A request that names only the binding being changed silently drops
every other binding. The sandbox worker `flexi-telegram-deal-bot-sandbox` was used to
confirm this before the production worker was touched.

The safe procedure is therefore:

1. `GET` the worker settings and keep the whole binding list.
2. Replace only the `text` of the binding being changed, and keep every other
   binding object byte for byte. `secret_text` bindings are sent by name without a
   value, which preserves the stored secret. `d1` bindings are sent with `id` and
   `database_id`, `kv_namespace` bindings with `namespace_id`, and the `ai` binding
   with `project`.
3. `PATCH` the full list as `multipart/form-data` with a `settings` part.
4. `GET` the settings again and compare binding count, secret count, every
   unchanged `plain_text` value, and every `d1` and `kv_namespace` id. Roll back to
   the captured list when anything differs.

The production worker holds 99 bindings, 11 of them secret. Both counts and every
other binding value were confirmed unchanged after the update.

## Contract

A Telegram deep link carries a start payload of the shape
`<eventKey>_deal_c<catalog index>`. The bot parses it with

```js
/^(?:(?<eventKey>[a-z0-9-]+)_)?deal_(?<companyId>[a-z0-9]+)$/iu
```

so the event key is lowercased and the company id keeps its case. The company id is
then resolved against the published JSON: a company matches when its `deal_payload`,
`telegramPayload` or `telegram_payload` equals `deal_<companyId>` or
`<eventKey>_deal_<companyId>`. The published catalogs store `deal_payload` with the
`deal_` prefix only, and their index is the index of the company **inside the
exhibition catalog**, not the position of the company inside the enriched subset.

`src/exhibition-telegram-deal-payload.js` mirrors that behaviour offline, and
`scripts/verify-exhibition-telegram-catalogs.mjs` replays it against the live
published catalog.

## Verification

`npm run test:sandbox-*` style probes are separate. The catalog probe is run
directly:

```sh
TELEGRAM_DEAL_EVENT_URLS_JSON_FILE=/path/to/binding.json \
  node scripts/verify-exhibition-telegram-catalogs.mjs
```

The probe only issues `GET` requests. It reads the published mapping, the published
card list, and every published company JSON, and it replays the bot payload grammar
and company resolution for every published company. It exits non-zero on the first
failed rule.

Result on 2026-10-20, with the live binding read back from the production worker:

| Event key | HTTP | Content type | Enriched / cards | Payload resolved | Notes path | Prelid divergence | Problems |
|---|---|---|---|---|---|---|---|
| `heatpower2026` | 200 | `application/json` | 7 / 58 | 7 | 200 | 7 | 0 |
| `expocoating2026` | 200 | `application/json` | 7 / 36 | 7 | 200 | 7 | 0 |
| `testingcontrol2026` | 200 | `application/json` | 4 / 98 | 4 | 200 | 4 | 0 |
| `ndtrussia2026` | 200 | `application/json` | 3 / 39 | 3 | 200 | 3 | 0 |
| `pcvexpo2026` | 200 | `application/json` | 4 / 83 | 4 | 200 | 4 | 0 |
| `fasttec2026` | 200 | `application/json` | 0 / 15 | 0 | — | 0 | 0 |
| `rds2026` | 200 | `application/json` | 12 / 172 | 12 | 200 | 12 | 0 |

Every published company resolves to the company it belongs to, and the live binding
resolves every one of the seven event keys to the URL that was published for it.
`fasttec2026` publishes an empty company list because that exhibition has no
enriched companies yet; the published JSON is still valid.

The notes path answers `200` for every catalog that publishes companies, and the
prelead key it returns differs from the prelead key the deal path uses for all 37
published companies. That divergence is the open finding below; the probe reports
it and only fails when `VERIFY_STRICT_PRELEAD_IDS=1` is set.

## Open findings

### The published catalog JSON carries no `meta` block

Every catalog that was already bound publishes a `meta` object with `event_key`,
`source_label`, `page_url` and `deal_type_key`. The seven new catalogs publish only
`companies`. The bot reads that block when it builds the deal, so a deal created
from these seven links is labelled with the default source `RosUpack 2026` and
links to `https://rosupack-floorplans-2026.pages.dev/?v=deal-payload` instead of
the exhibition page. The company resolution itself is not affected.

The exact fallbacks are in the deployed bot source:

```js
// rosupackSourceLabel()
meta.source_label || env.ROSUPACK_SOURCE_LABEL || sourceLabelFromEventKey(eventKey) || "RosUpack 2026"
// rosupackPageUrl()
meta.page_url || env.ROSUPACK_PAGE_URL || "https://rosupack-floorplans-2026.pages.dev/?v=deal-payload"
// rosupackDealTypeKey()
meta.deal_type_key || meta.sales_channel
```

The production worker has neither `ROSUPACK_SOURCE_LABEL` nor `ROSUPACK_PAGE_URL`
bound, and `sourceLabelFromEventKey()` has no branch for the seven new event keys,
so both defaults apply.

Fix: publish the same `meta` block for the seven catalogs:

```json
"meta": {
  "event_key": "heatpower2026",
  "source_label": "Heat&Power 2026",
  "page_url": "https://exhibition-catalog-review.pages.dev/heatpower/",
  "deal_type_key": "exhibition"
}
```

`deal_type_key` is not critical: the bot maps `exhibition` and `conference` to the
same value.

### Notes and rejection use a different company identifier than the deal payload

The published catalog page sends notes and rejections with the internal company id
`<eventKey>-<index>`, for example `heatpower2026-3`, and the published notes
endpoint answers with the prelead key `site_heatpower2026_heatpower2026-3`. The
Telegram deal path uses the short payload id `c3` for the same company, which
resolves to the prelead key `site_heatpower2026_c3`.

The mechanism is in the bot source. When a deal is created from a payload, the bot
writes its `site_deal` marker into the prelead of the **payload** id:

```js
const preleadId = sitePredealId(payload.eventKey, payload.companyId);
```

while the catalog page posts its note under the **internal** id:

```js
f.set('companyId', EXHIBITIONS[idx].id + '-' + card.id);
```

The two paths therefore address different prelead records, and a note or a
rejection made on the catalog page is not attached to the deal created from the same
company's Telegram link. All 37 published companies of the seven catalogs are
affected.

The catalogs that were already bound do not have this problem: they publish the
short id in the `id` field, so both paths agree. The production prelead table
holds `site_agroprodmash2026_c0`, `site_agrosalon2026_c83` and
`site_cematrussia2026_c51` for exactly that reason.

The short id is required on the payload side, because the bot only reads letters
and digits after `deal_` and cannot parse `heatpower2026-3`. The fix is therefore
on the catalog side, in the page that posts the note:

```js
// before: notes go to site_heatpower2026_heatpower2026-3
f.set('companyId', EXHIBITIONS[idx].id + '-' + card.id);
// after: notes go to site_heatpower2026_c3, the prelead the deal marker uses
f.set('companyId', 'c' + card.id);
```

The alternative is a bot change that writes the `site_deal` marker under
`company.id` from the published catalog instead of `payload.companyId`. The bot
source is not in any repository this token can reach, so that route needs the owner
of the bot deployment.

### Nothing else reads the binding

Notes and the rejection state on the published catalog run in the catalog's own
Pages Function, and the CRM application keeps its rejection and undo-rejection
state in its own D1 prelead events (`src/prelead-timeline.js`,
`src/built-d1-offline-mcp.js`). None of them read `TELEGRAM_DEAL_EVENT_URLS_JSON`,
so extending the binding cannot change the note and rejection behaviour.

The bot also guards its notes endpoint with an origin allowlist
(`SITE_NOTES_ALLOWED_ORIGINS` plus a built-in default list). That gate is not a
blocker for these seven catalogs: the catalog's Pages Function calls the bot
without an `Origin` header, and the bot accepts a request without an origin. A
direct browser call with a foreign origin is answered with `403 Forbidden`, which
is the intended behaviour and does not apply to the published pages.

## Test group

The exhibition links are published in a Telegram group, and the bot only accepts
group messages when the chat id is in its allowlist:

- `TELEGRAM_ALLOWED_CHAT_ID` — secret, holds the main list
- `TELEGRAM_EXTRA_ALLOWED_CHAT_IDS` — `plain_text`, currently
  `-5253164492,-5423408115,-5441770657`
- `TELEGRAM_TEST_CHAT_IDS` — `plain_text`, currently `-5213761301`

`TELEGRAM_ALLOW_ALL_CHATS` is not bound on the production worker, so the allowlist
is mandatory for groups. Private chats with the bot are allowed by default.

The test group `-5441770657` was added to `TELEGRAM_EXTRA_ALLOWED_CHAT_IDS` on
2026-10-20 with the binding procedure described above. The readback confirmed
99 bindings, 11 secrets, and a single changed value.

A group that is not in the allowlist is not silently ignored: the bot answers with
"добавьте этот id в TELEGRAM_ALLOWED_CHAT_ID, TELEGRAM_TEST_CHAT_IDS или
TELEGRAM_EXTRA_ALLOWED_CHAT_IDS", stores the chat in `deal-bot:setup:chat:<id>` for
seven days, and alerts the operator chat `1714048`.

### Check contour for one exhibition

1. Open the exhibition page, for example
   `https://exhibition-catalog-review.pages.dev/heatpower/`, and press
   "✈ Создать сделку" on a company card. The deep link carries
   `<eventKey>_deal_c<catalog index>`, for example `heatpower2026_deal_c3`.
2. The bot resolves the company from the published JSON and creates the deal.
3. Read back what the bot wrote, without writing anything:

```sh
# the prelead of the deal marker, the source label and the rejected flag
SELECT id, company_name, source_label, status FROM preleads
  WHERE id LIKE 'site_heatpower2026%';
```

4. Check the published notes endpoint of the same company:

```sh
curl "https://exhibition-catalog-review.pages.dev/api/notes?eventKey=heatpower2026&companyId=heatpower2026-3"
```

5. Compare the two prelead keys. While the catalog keeps its current identifier
   format, the notes path answers with `site_heatpower2026_heatpower2026-3` and the
   deal marker lands in `site_heatpower2026_c3`.

`scripts/verify-exhibition-telegram-catalogs.mjs` automates step 4 and reports the
same comparison for all seven catalogs. It is read-only: it issues `GET` requests
and reads an optional local copy of the live binding.
