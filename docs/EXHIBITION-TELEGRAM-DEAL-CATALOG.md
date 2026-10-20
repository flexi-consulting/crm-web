# Exhibition Telegram deal catalog

This note records how the published exhibition catalogs are connected to the Telegram
deal intake, how the connection was verified, and what is still open.

The catalog button is a deep link to `@cmr_management_bot`:

```
https://t.me/cmr_management_bot?start=<eventKey>_deal_<companyId>
```

That bot is the deployed `trained-assist-tg-bot-sales` Worker. It owns no Weeek
credentials, so it cannot create a deal itself. The deal is created by the
`flexi-telegram-deal-bot` Worker, which owns the Weeek credentials, the catalog
binding and the prelead storage. The two workers talk over a private HTTP bridge,
described in [Deal intake bridge](#deal-intake-bridge).

`flexi-telegram-deal-bot` reads one binding for this integration,
`TELEGRAM_DEAL_EVENT_URLS_JSON`, and it is the only consumer of that binding in the
bot source (`rosupackCompaniesUrlByEvent`). Nothing else in the bot, and nothing in
the CRM application, reads it.

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

The production worker holds 102 bindings, 12 of them secret: the 99 bindings of the
catalog update plus the three of the bridge, `EXHIBITION_DEAL_API_KEY`,
`EXHIBITION_DEAL_API_URL` and `TELEGRAM_DEAL_EVENT_META_JSON`. Both counts and
every other binding value were confirmed unchanged after each update.

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

## Deal intake bridge

### Why a bridge

The published catalogs link to `@cmr_management_bot`, which is served by
`trained-assist-tg-bot-sales`. That worker is the sales assistant bot: it owns the
Telegram session KV and the agent credentials, but no Weeek credentials and no
catalog binding, so it cannot resolve a company or create a deal. The worker that
does own them, `flexi-telegram-deal-bot`, was serving a different Telegram bot that
is dormant.

The bridge keeps the catalog link pointing at `@cmr_management_bot` and moves only
the deal creation to the worker that can do it:

```
catalog page
  └─ https://t.me/cmr_management_bot?start=heatpower2026_deal_c3
       └─ trained-assist-tg-bot-sales  (parses the payload, asks the bridge)
            └─ POST https://flexi-telegram-deal-bot.../api/exhibition/deal
                 └─ flexi-telegram-deal-bot  (resolves the company, creates the Weeek deal)
       └─ the chat gets the result
```

### The endpoint

The bridge endpoint lives on the exhibition deal bot:

```
POST /api/exhibition/deal
X-Exhibition-Key: <EXHIBITION_DEAL_API_KEY>

{ "eventKey": "heatpower2026", "companyId": "c3", "chatId": "1714048",
  "userId": "1714048", "userName": "operator", "dryRun": false }
```

| Field | Meaning |
|---|---|
| `eventKey` | the exhibition event key, lowercased; optional when the catalog is unambiguous |
| `companyId` | the short payload id, `c<catalog index>`; letters and digits only |
| `chatId`, `userId`, `userName` | the chat the request came from, used for the deal attribution |
| `dryRun` | when `true`, the company is resolved and the draft is prepared, and nothing is written |

The answer is the payload the sales bot formats for the chat:

```json
{ "ok": true, "companyName": "АГУНА ТЕПЛО, ООО", "title": "АГУНА ТЕПЛО, ООО Сколково",
  "sourceLabel": "Heat&Power 2026", "eventKey": "heatpower2026", "companyId": "c3",
  "dealId": "1714049", "dealUrl": "https://app.weeek.com/crm/deals/1714049",
  "preleadId": "site_heatpower2026_heatpower2026-3", "warnings": [] }
```

Errors answer with `ok: false` and an `error` code: `unauthorized` (401),
`method_not_allowed` (405), `company_not_found` (404), `company_name_missing` (422),
`catalog_unavailable` (502) and `deal_creation_failed` (502).

The sales bot only calls the bridge when the chat has a logged in session
(`session.username`), and it answers the chat in Russian: the deal that was created
with its id and link, or the reason why it was not created.

### The bindings

| Worker | Binding | Type | Value |
|---|---|---|---|
| `flexi-telegram-deal-bot` | `EXHIBITION_DEAL_API_KEY` | secret | the shared bridge key, checked against `X-Exhibition-Key` |
| `flexi-telegram-deal-bot` | `EXHIBITION_DEAL_API_URL` | plain_text | the url of the exhibition deal bot, not read by this worker |
| `flexi-telegram-deal-bot` | `TELEGRAM_DEAL_EVENT_META_JSON` | plain_text | event name and page url per event key |
| `trained-assist-tg-bot-sales` | `EXHIBITION_DEAL_API_KEY` | secret | the same shared bridge key, sent as `X-Exhibition-Key` |
| `trained-assist-tg-bot-sales` | `EXHIBITION_DEAL_API_URL` | plain_text | the url of the exhibition deal bot |

The key is a secret on both sides, so neither the key nor the url of the bridge is
readable from the repository. `scripts/apply-exhibition-worker-bindings.mjs` takes
the key from the environment and writes it to both workers; the value is never
printed.

`TELEGRAM_DEAL_EVENT_META_JSON` holds the fallback metadata of the published
catalogs, see [The published catalog JSON carries no `meta` block](#the-published-catalog-json-carries-no-meta-block).
Its source of truth is `fixtures/exhibition-event-meta.json` in this repository.

### The source of the injected code

Both workers are deployed as generated bundles, so the injected code is kept in this
repository and inlined into the bundle at deploy time:

| File | Role |
|---|---|
| `src/exhibition-deal-bridge.js` | the shared payload grammar and the reply format |
| `src/worker-patches/exhibition-deal-legacy-endpoint.js` | the bridge endpoint of the exhibition deal bot |
| `src/worker-patches/exhibition-deal-sales-handler.js` | the start payload handler of the sales bot |
| `scripts/patch-workers-exhibition-deal.mjs` | builds and uploads the patched bundles |
| `scripts/apply-exhibition-worker-bindings.mjs` | applies the bindings of the bridge |
| `scripts/lib/cloudflare-api.mjs` | the Cloudflare Workers API helpers |

The patcher is idempotent: it replaces the block it injected before, so it can be
run again over an already patched worker.

### Deploying

```sh
# 1. the shared secret; the value never lives in the repository
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
  EXHIBITION_DEAL_API_KEY=... \
  node scripts/apply-exhibition-worker-bindings.mjs

# 2. the code
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
  node scripts/patch-workers-exhibition-deal.mjs --out .tmp/workers --upload
```

Both scripts print the binding diff after every write. The upload sends the worker
metadata with `keep_bindings` for every binding type the worker holds, so no
binding and no secret is lost by a code update; the patcher compares the binding
list before and after the upload and reports the difference.

The bundle is sent as a module part with the content type
`application/javascript+module`. The content type decides whether the runtime
treats the part as a module or as a classic script, and a classic script rejects
the `export` statement of the bundle.

### Verifying

The endpoint is the only part that can be checked without Telegram. A dry run
resolves the company and prepares the draft, and writes nothing:

```sh
curl -X POST "https://flexi-telegram-deal-bot.skillset-apply.workers.dev/api/exhibition/deal" \
  -H "Content-Type: application/json" \
  -H "X-Exhibition-Key: $EXHIBITION_DEAL_API_KEY" \
  -d '{"eventKey":"heatpower2026","companyId":"c3","dryRun":true}'
```

The end to end check needs a real Telegram click, because the webhook of the sales
bot only accepts updates with its own secret token. The check is described in
[Check contour for one exhibition](#check-contour-for-one-exhibition).

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
| `heatpower2026` | 200 | `application/json` | 7 / 58 | 7 | 200 | 0 | 0 |
| `expocoating2026` | 200 | `application/json` | 7 / 36 | 7 | 200 | 0 | 0 |
| `testingcontrol2026` | 200 | `application/json` | 4 / 98 | 4 | 200 | 0 | 0 |
| `ndtrussia2026` | 200 | `application/json` | 3 / 39 | 3 | 200 | 0 | 0 |
| `pcvexpo2026` | 200 | `application/json` | 4 / 83 | 4 | 200 | 0 | 0 |
| `fasttec2026` | 200 | `application/json` | 0 / 15 | 0 | — | 0 | 0 |
| `rds2026` | 200 | `application/json` | 12 / 172 | 12 | 200 | 0 | 0 |

Every published company resolves to the company it belongs to, and the live binding
resolves every one of the seven event keys to the URL that was published for it.
`fasttec2026` publishes an empty company list because that exhibition has no
enriched companies yet; the published JSON is still valid.

The notes path answers `200` for every catalog that publishes companies, and the
prelead key it returns is the key the deal path writes its marker into, so a note,
a rejection and the deal of one company end up in the same prelead record. The
probe reports the divergence and fails when `VERIFY_STRICT_PRELEAD_IDS=1` is set;
with the bridge in place the strict run passes with a divergence of 0.

## Open findings

### The published catalog JSON carries no `meta` block

Every catalog that was already bound publishes a `meta` object with `event_key`,
`source_label`, `page_url` and `deal_type_key`. The seven new catalogs publish only
`companies`. The bot reads that block when it builds the deal, so a deal created
from these seven links would be labelled with the default source `RosUpack 2026` and
would link to `https://rosupack-floorplans-2026.pages.dev/?v=deal-payload` instead
of the exhibition page. The company resolution itself is not affected.

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

The bridge answers this from the worker side: it reads
`TELEGRAM_DEAL_EVENT_META_JSON` and fills the empty fields of the catalog metadata
with the event name and the page url of that event. A dry run of
`heatpower2026` / `c3` reports the source `Heat&Power 2026` and the comment
"Создано со страницы Heat&Power 2026". The map is kept in
`fixtures/exhibition-event-meta.json` and covers all 19 bound event keys.

The catalog side stays the better fix, because the catalog owns the event name and
the page url of its own page. Publish the same `meta` block for the seven catalogs:

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
Telegram payload only carries the short id `c3` for the same company.

The short id is required on the payload side, because the bot only reads letters
and digits after `deal_` and cannot parse `heatpower2026-3`. The prelead key is
built by the bot from the company id it resolves, so the two paths could address
different prelead records, and a note or a rejection made on the catalog page would
not be attached to the deal created from the same company's Telegram link. All 37
published companies of the seven catalogs were affected.

The bridge resolves this from the worker side: it writes the `site_deal` marker
under the id the **catalog publishes**, not under the payload id:

```js
const preleadCompanyId = clean3(company.id) || companyId;
const preleadId = sitePredealId(eventKey, preleadCompanyId);
```

The published catalog of the seven new exhibitions carries the internal id in its
`id` field (`heatpower2026-3`), and the catalogs that were already bound carry the
short id there (`c83`), so both kinds of catalog now write their marker into the
prelead that the notes path uses. `site_heatpower2026_heatpower2026-3` holds the
notes, the rejection state and the deal of the same company.

The catalog side stays the better fix for the opposite direction: when the catalog
posts its notes under the short id, both paths address the same record without
the bot having to know the catalog id format.

```js
// before: notes go to site_heatpower2026_heatpower2026-3
f.set('companyId', EXHIBITIONS[idx].id + '-' + card.id);
// after: notes go to site_heatpower2026_c3, the prelead the deal marker uses
f.set('companyId', 'c' + card.id);
```

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
  `-5253164492,-5423408115,-1004485888030`; the new production group is
  `-1004485888030`
- `TELEGRAM_TEST_CHAT_IDS` — `plain_text`, currently
  `-5213761301,-5441770657`; the exhibition deal acceptance and CI test group
  is `-5441770657`

`TELEGRAM_ALLOW_ALL_CHATS` is not bound on the production worker, so the allowlist
is mandatory for groups. Private chats with the bot are allowed by default.

The test group `-5441770657` was first added to
`TELEGRAM_EXTRA_ALLOWED_CHAT_IDS` on 2026-10-20. It was then moved to
`TELEGRAM_TEST_CHAT_IDS` when the separate production group was assigned. Run
`npm run update:exhibition-chat-bindings` with `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` to repeat the two-binding update. The script preserves
the other bindings and verifies the complete readback. The repository CI suite
uses synthetic fixtures; creating a real Weeek deal still requires a Telegram
acceptance click in the test group.

A group that is not in the allowlist is not silently ignored: the bot answers with
"добавьте этот id в TELEGRAM_ALLOWED_CHAT_ID, TELEGRAM_TEST_CHAT_IDS или
TELEGRAM_EXTRA_ALLOWED_CHAT_IDS", stores the chat in `deal-bot:setup:chat:<id>` for
seven days, and alerts the operator chat `1714048`.

The catalog button does not need that allowlist: a `?start=` deep link opens a
private chat with `@cmr_management_bot`, and private chats are accepted by both
bots. The allowlist only governs the group messages of the legacy bot.

### Check contour for one exhibition

1. Open the exhibition page, for example
   `https://exhibition-catalog-review.pages.dev/heatpower/`, and press
   "✈ Создать сделку" on a company card. The deep link carries
   `<eventKey>_deal_c<catalog index>`, for example `heatpower2026_deal_c3`.
2. The bot answers in the chat that the deal was created, with its id and its link.
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

5. Compare the two prelead keys. Both are `site_heatpower2026_heatpower2026-3`: the
   notes path and the deal marker address the same prelead record.

`scripts/verify-exhibition-telegram-catalogs.mjs` automates step 4 and reports the
same comparison for all seven catalogs. It is read-only: it issues `GET` requests
and reads an optional local copy of the live binding.
