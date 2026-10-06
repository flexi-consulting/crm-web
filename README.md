# CRM Web

An optional profile-free read-only exhibition facts projection is described in
[`docs/PUBLIC-EXHIBITION-FACTS.md`](docs/PUBLIC-EXHIBITION-FACTS.md). It is disabled
by default; no captured event has the separate publication-rights approval yet.

Independent CRM and exhibitions web service. This work is a local synthetic API/domain-logic foundation. Catalog and company reads use fixtures; the exhibition extension adds a hidden synthetic catalog-build pipeline; the sales extension prepares in-memory intents and includes an unadvertised synthetic confirmed-deal state machine behind a fake provider. None of these routes writes to a live CRM or scrapes live sites. Mutating deal-intent, prelead timeline, confirmed-deal, and catalog-build routes are omitted from the published manifest, so the agent cannot discover them as capabilities.

## Run locally

Requires Node.js 20 or newer.

```sh
npm start
```

Open `http://127.0.0.1:3000`. The UI displays invented catalog entries and identifies them as synthetic.

## Contract v1

- `GET /api/v1/manifest` returns stable `serviceId`, release version/source revision/environment, platform contract range, domain API version, typed capabilities, schema references, effects/scopes, compatibility data, readiness state/version tuple, and endpoint references.
- `GET /api/v1/readiness` reports `ready` for this local process and includes its checked version tuple. Its scope is explicitly `local_process_only`; it does not probe providers, credentials, or external dependencies and is not proof of platform binding readiness.
- `GET /api/v1/catalog` returns the synthetic catalog; optional `q` searches name, city, and country. Unknown parameters, repeated `q`, and `q` values longer than 120 Unicode characters return 400.
- `GET /api/v1/companies` is the S-01 exhibition participant view: it returns synthetic company/event identities and the qualification overlay belonging to the trusted profile. The page consumes this same scoped API. Profile identity and `crm.companies.read` scope come only from the injected resolver, never from query/tool arguments.
- `POST /api/v1/deal-intents` prepares an in-memory synthetic pre-deal intent using an `Idempotency-Key`; `GET /api/v1/deal-intents/{id}` reads the profile-owned intent and reconciles its status through the fake Weeek adapter. This is not confirmed deal creation. Reconciliation is a status read and does not replay the preparation operation.
- S-03 prototype routes `GET /api/v1/preleads/{id}/timeline` and `POST /api/v1/preleads/{id}/events` read/append synthetic note and disposition events. `operationId` is required and profile-scoped for idempotency. Undo appends a `rejection_undone` event targeting the active rejection; projection uses the latest disposition event and preserves the full history. These routes are not published capabilities.
- S-04 foundation includes `POST /api/v1/deal-operations/{operationId}/reconcile` and `/repair`, with an in-memory `pending` / `created` / `unknown` / `rejected` ledger through a fake provider. A `created` result requires a validated synthetic deal ID. An `unknown` result must reconcile before another create attempt; repair never creates another deal. The older `POST /api/v1/deals/confirm` route accepted a `confirmation: true` caller assertion, which is not evidence of human intent; it is disabled by default and enabled only in its legacy unit tests. Reviewed create uses the routes described below. None of these routes is a published capability.
- S-02 foundation routes `POST /api/v1/catalog-builds` and `GET /api/v1/catalog-builds/{buildId}` run synthetic source validation/import, duplicate-name removal, enrichment with provenance, registry outcomes, conservative qualification, and deterministic JSON artifact/report generation. Duplicate or unsafe source IDs block before enrichment/registry calls. Provider failures remain typed `unavailable`/`unknown` outcomes and are visible in the report. Schemas are `catalog-build-request`, `catalog-build-artifact`, `catalog-build-report`, `catalog-build-response`, and `catalog-build-error`. Routes require an injected profile resolver and are not published capabilities.
- `POST /api/v1/catalog-builds/{buildId}/preview` and `GET /api/v1/catalog-previews/{previewId}` render a deterministic, in-memory HTML preview from a validated synthetic artifact. The descriptor binds preview ID to build ID, source revision, and renderer revision, and carries a markup validation report. Text is HTML-escaped; links are revalidated as HTTP(S); the page is marked `noindex`, sets a restrictive CSP, and has inert local search/filter behavior only. It does not publish or deploy. Schemas are `catalog-preview-response`, `catalog-preview-report`, and `catalog-preview-error`.
- `GET /api/v1/catalog-builds/{buildId}/participants` reads the validated S-02 artifact as an S-01 participant list for the same trusted profile. It supports bounded `q` and `classification` filters; each item carries its source, enrichment and registry provenance plus a stable detail path. `GET .../participants/{companyId}` resolves the same item. An offline-only MCP descriptor/test transport calls the same `readParticipants` method and checks HTTP parity, schema, profile isolation, denied scope and invalid input. These routes read process-local synthetic builds only; the descriptor is absent from the published manifest. The original `/api/v1/companies` fixture and public S-01 capability still use a separate static dataset until catalog ownership, durable build storage and migration of its consumers are established.

### Synthetic built participant action path

`POST /api/v1/catalog-builds/{buildId}/participants/{companyId}/prelead` binds one validated `co-*` participant to a stable profile/event/company `built-prelead-*` identity. Rebuilding the same event/company adds a source build reference and preserves notes and disposition; replaying one binding does not add another reference. It requires `crm.preleads.create.synthetic`. The bound prelead accepts the existing note/reject/undo timeline commands. Reviewed S-04 input can include `buildId` only with a `co-*` company; the same `createParticipantResolver` validates ownership and event identity for binding, review and fake deal creation. The review captures current notes and source event, requires an injected trusted approval receipt, and links one fake deal back to the same prelead. HTTP and the existing offline S-04 MCP test transport share the review/deal service. The Node HTTP service still keeps this path process-local; the new route and built participant descriptor are absent from the published manifest. The older `demo-company` path remains compatible.

### Conditional durable built catalog contract

`src/legacy-ex-snapshot.js` imports the parsed `EX` array produced by the old
sales catalog generator into the same app-owned D1 build/participant contract.
It derives a revision from the fields actually imported, preserves the old
`eventKey + company id` pair through an additive `0004_legacy_catalog_refs.sql`
mapping, and keeps the new participant ID stable across name changes and
rebuilds. Legacy target/near-target flags remain marked
`legacy_classification_unverified`; registry state is `unknown`. Repeated or
unsafe old IDs stop the entire import before D1 writes. Contact email/phone
fields are excluded from the public artifact and revision. An offline Worker
test covers import, profile isolation, old-link lookup, a revised snapshot,
notes and one reviewed fake deal. Removed legacy IDs stop resolving in the
latest snapshot. This is an opt-in internal import contract; the published
catalog page and `/api/v1/companies` still use demo data. Real source file
selection, public URL routing, old notes/deal-status migration, full legacy
financial/card fields and production approval/profile issuers remain open.
The private capture and local D1 restore procedure, including GCP aggregate
inventory and quarantine rules, is in [docs/LEGACY-CATALOG-HANDOFF.md](docs/LEGACY-CATALOG-HANDOFF.md).

`migrations/0002_built_catalog.sql` adds build artifacts, participant membership and build references to the **separate app-owned D1 candidate** created by `0001_s04_domain.sql`. `src/built-catalog-d1.js` persists a validated synthetic build under profile/idempotency key, reads the exact profile-owned participant, binds a stable prelead across rebuilds, and appends a note with D1 replay protection. The existing S-04 D1 repository then reads the same prelead revision and notes for reviewed deal creation. `createDealReviewService` accepts the async D1 participant resolver in its persistent path; its in-memory handler and older demo IDs remain intact.

`fixtures/built-catalog-d1-worker.js` and `test/wrangler.built-catalog-local.toml` are **local test harnesses only**. CI applies both migrations to a temporary D1, exercises build → card → prelead → note, restarts the Worker, verifies the same history under a rebuild, prepares a revision-bound review, restarts again, confirms one fake deal and checks replay on a further process. It also stores a valid artifact with a different company order and rejects malformed read filters. A second test reserves an unknown provider outcome and confirms no second provider POST after restart. Wrangler test files run serially because local Worker runtime ports can collide when separate fixtures start concurrently. This is local Worker/D1 evidence, not a production binding. The Node HTTP service is still in-memory; no new migration is applied to the legacy bot database. Preview HTML, production profile/approval issuer, real catalog import, deployed MCP relay and Weeek test-workspace integration are still open.

### Opt-in D1 HTTP and offline MCP contract

`src/built-catalog-d1-http.js` adds a Fetch API adapter over the same app-owned D1 repositories. It is disabled unless its caller passes `enabled: true`; the production Node entry point does not import or enable it. In the local-only `fixtures/built-d1-http-worker.js`, the test config explicitly sets `D1_CONNECTED_APP_ENABLED=true`. The adapter exposes the existing synthetic URL shapes for build/read, participant list/card, prelead binding/events/timeline, reviewed deal prepare/get/confirm and operation get/reconcile/repair. It checks a durable idempotency key before rebuilding a catalog, so replay does not rerun the synthetic source/enrichment pipeline. Profile and scopes come from an injected resolver; the test fixture uses headers solely to simulate that trusted boundary. The default Node HTTP mode remains in-memory.

`src/built-d1-offline-mcp.js` is a Worker-safe, test-only JSON-RPC contract for S-01 built participant reads, S-03 note/reject/undo/timeline and S-04 reviewed deals. It calls the same D1 domain services as HTTP. Worker runtime does not allow Ajv's runtime code generation, so this offline adapter checks inputs before dispatch and the Node contract test compiles the declared JSON Schemas to validate results and HTTP/MCP parity. The D1 test crosses Worker restarts, two invented profiles, rebuild and an unknown provider outcome without repeating a POST. This is not a deployed MCP server or proof of real relay compatibility. Durable D1 S-03 rejection/undo is covered in [its own contract note](docs/S-03-D1-DISPOSITION.md); the original published S-01 `/api/v1/companies` capability still uses `demo-company` fixtures. Production identity, approval issuer, real Weeek integration, static catalog UI actions and cutover are separate gates.

The same opt-in local D1 adapter now renders read-only browser pages at `GET /catalogs/{buildId}` and `/catalogs/{buildId}/participants/{companyId}`. The list uses the exact profile-scoped D1 participant read as the REST/MCP contract, with name/country/booth search and classification filters. The card shows its source revision, qualification reason, available financial/legal fields, and explicit unknown enrichment; source and company URLs are checked again before rendering. Both routes require the injected trusted profile and `crm.catalog.build.read.synthetic` scope, are disabled with the adapter, and return no-store HTML with a restrictive CSP. Local Worker tests compare card identity with the REST payload and cover another profile, denied scope, malformed filters and restart. This is a synthetic browser proof; it does not serve the captured private EX backup, redirect old static catalog links, expose notes/deal actions, provide production authentication, or publish a catalog.

The opt-in local adapter also exposes `GET /api/v1/legacy-catalog-links/{eventKey}/{legacyCompanyId}?sourceRevision=legacy-ex-sha256-…` as a **resolver response**, with `detailPath` and `browserPath` only after the trusted profile, event and exact current imported source revision match. It does not issue a redirect. Duplicate or unsafe old IDs are blocked before local fixture import; malformed lookup IDs return 400, a missing or removed ID returns 404, and a changed revision returns 409 so an old link cannot silently point at a rebuilt catalog. Local Worker tests use invented EX rows, including duplicate/unsafe quarantine, a renamed rebuild and a removed company. A real source revision must come from a reviewed private handoff mapping that binds the captured byte receipt to the projected EX revision; there is no production route mapping or historical static URL rewrite in this slice.
- Other paths return JSON 404. Unsupported methods are rejected with 405.

JSON Schemas live in `schemas/`, including typed request/response/event/error schemas for the synthetic catalog build, deal-intent, prelead timeline, confirmed-deal boundaries, and all four C14 readiness states. `CRM_WEB_RELEASE_VERSION`, `CRM_WEB_SOURCE_REVISION`, and `CRM_WEB_ENVIRONMENT` can identify a built release; local defaults are `0.1.0`, `working-tree`, and `development`. `npm test` runs HTTP behavior and contract/schema checks on Node's built-in test runner; CI runs the same check.

Profile-scoped company, deal-intent, prelead, confirmed-deal, catalog-build, and preview routes require a trusted-profile resolver injected into `createServer`. It must supply profile identity and granted scopes separately; each operation enforces a least-privilege scope. No production resolver is configured in this slice, so those routes fail closed with 503 by default; tests inject a synthetic resolver to verify profile isolation and 403 scope denial. The request body contains no profile identity or scopes. The fake providers, source snapshots, build/preview artifacts and reports, company ownership assignments, operation ledgers, and event stores are process-local synthetic fixtures; none writes CRM/Weeek data or survives restart.

This PR is an API/domain-logic foundation only: it adds no browser create-deal flow and does not establish actual agent relay parity. Its fake confirmed-deal path is not production S-04 completion or safe to register as an agent capability. Canonical CRM writer, durable operation ledger, provider receipt/reconciliation semantics, canonical company ownership, the platform source for trusted profile context/scopes, and the relay contract remain unresolved.

### S-03 event model boundary

Read-only review of the current legacy Worker shows site notes appended to prelead-message history and reject/unreject actions appended as status entries; the current view derives disposition from the latest status entry. The existing prelead model is distinct from a confirmed CRM deal. This synthetic foundation models note, rejection, and undo as typed append-only events, with undo retaining the rejection event it reverses. This mapping is not proof that this repository owns the legacy D1 records; the canonical owner and migration boundary remain unresolved.

This slice handles text fixtures only. It does not accept, transcribe, or store audio. Recording consent, transcription consent, retention periods, transcript retention, and deletion policy remain open decisions before any audio path is introduced.

### S-02 catalog build boundary

This implementation is limited to fixture-only pre-publication stages in `exhibition/01-exhibition-catalog-to-sales-site`: source validation/import, name deduplication, enrichment outcome/provenance, registry outcome, conservative qualification, deterministic artifact/report validation, and deterministic HTML preview. Preview borrows the legacy catalog's browse structure (search, filters, grouped cards, and qualification/status badges), while excluding remote note/audio/deal actions and persistent user state. Only enrichment with status `found` can retain identity/revenue data or qualify as target; malformed enrichment fails closed. Unsafe source links are rejected, emitted URLs are limited to safe HTTP(S), and empty provenance IDs are rejected. Neither build nor preview scrapes a live exhibition catalog, creates the production site, opens a PR in a source repository, deploys, or publishes. Production deployment still needs reviewed field mapping, real authentication, provider/data ownership contracts, accessibility and performance validation, and a separate publication/review workflow. This preview is not a published site.

The manifest follows the proposed [C14 connected application contract](https://github.com/trained-assist/trained-agent-architecture/blob/refs/pull/150/head/contracts/C14-CONNECTED-APPLICATION.md); runtime registration, compatibility negotiation, and authenticated platform readiness are not implemented here.

## Conditional S-04 D1 storage contract

`migrations/0001_s04_domain.sql` and `src/s04-d1-repository.js` are an additive storage contract for a **new, app-owned D1 database if CRM Web is later deployed with a separate Worker binding**. D1 is a candidate because the legacy exhibition notes already use Worker/D1; no CRM Web hosting, database ownership or canonical-writer decision is made here. Never apply this migration to the legacy bot database or deploy the local test Worker. The existing Node HTTP service does not import this adapter, and there is no production binding, live data, credential or Weeek call.

The schema keeps profile/event/company identity, prelead events, review snapshots, trusted receipt metadata and deal operations together. Its partial unique index reserves one active deal per profile/event/company across Worker invocations. `reserve()` checks the exact review revision, current prelead revision and trusted receipt, then writes `unknown` and consumes the receipt in one D1 batch **before** any hypothetical provider dispatch; only `reserved_unknown` grants dispatch permission. A replay returns the existing operation and never grants dispatch. A validated synthetic deal ID can change `unknown` to `created`; `linkVerifiedDeal()` inserts the `deal_linked` event, advances the prelead revision and marks the operation linked in one D1 batch. A failed batch leaves the operation created with a pending link for repair. Provider reconciliation still needs a queryable Weeek operation marker before any real POST can be safe.

`test/wrangler.s04-local.toml` and `fixtures/d1-worker.js` are a local-only harness with invented IDs and a temporary database. Wrangler is pinned as a development dependency, and the Worker D1 test is required in CI on Node 22. Run it locally with `npm test` after `npm ci` on Node 22 or newer. The test applies the migration locally, races two reservations, restarts the Worker, checks unknown replay, validates a created deal ID, forces a middle-of-batch link failure and verifies rollback, repairs the link and rejects a stale review. It is storage-contract evidence, not a production migration or provider canary.

The local Worker also exercises the existing S-04 review domain handler through a D1 storage port and a fake provider. Review snapshots, exact profile/event/company prelead lookup, revision-bound receipt metadata, reservations, operations and verified links survive a Worker restart. The harness mints a synthetic trusted receipt only from its test header; a caller's `confirmation: true` body is rejected. After an uncertain fake provider result, the stored operation stays `unknown` and replay never dispatches another create. The Node HTTP service has no D1 binding, and the D1 target remains conditional. A production cutover still needs a trusted approval issuer, a durable provider correlation/reconciliation contract, canonical profile and company ownership, deployment topology and a separate release review.

### Conditional Weeek correlation contract

`src/weeek-http-transport.js` implements the documented public Weeek REST
shape behind that correlation contract. It uses a fixed HTTPS API origin,
requires an injected profile-bound token resolver, and maps create/list/detail
responses into the existing provider port. The offline HTTP fixture tests the
exact endpoint/method/query/body sequence, token isolation, malformed response
handling, and a timeout after POST that reconciles by scanning configured
statuses without a second POST. The transport is not registered in the Worker
or Node service and has no production token resolver. Weeek workspace status
scope, real deal IDs, read consistency, and actual provider behavior need an
authorized test workspace canary before a live write can be enabled.

The OpenAPI `Deal.id` is an opaque string unique within the deal resource of a
workspace, with no published numeric or UUID pattern. The D1 operation ledger
and reviewed output schema therefore accept a bounded, printable opaque ID,
retain the exact value, and reject a second operation claiming the same deal ID
within one profile through additive `0003_weeek_deal_identity.sql`. A replay
must retain both the ID and correlation marker;
an ID collision leaves the later operation `unknown`, without another POST or a
catalog link. The test accepts invented numeric and punctuation-bearing IDs.
The production profile-to-Weeek-workspace binding remains unverified, so this
profile-scoped uniqueness rule is a conservative contract, not proof of global
ID uniqueness or live workspace identity.

`src/weeek-correlation-provider.js` is an injected-transport contract exercise, not a configured Weeek client. The [current official Weeek OpenAPI asset](https://developers.weeek.net/assets/weeek.yaml-Bhx55p8P.js) documents `POST /crm/statuses/{statusId}/deals` with a writable `description`, `GET /crm/statuses/{statusId}/deals` with `limit`/`offset` and `hasMoreDeals`, and `GET /crm/deals/{id}` with the description. It does **not** document a POST idempotency key or guarantee that `search` matches descriptions, so the adapter never uses search to prove uniqueness. The legacy [sales skill create flow](https://github.com/trained-assist/trained-assist-sales-skill/blob/main/src/mcp-skills/tools/30-weeek.js) sends a plain POST; its separate [catalog binding flow](https://github.com/trained-assist/trained-assist-sales-skill/blob/main/src/mcp-skills/tools/92-flexi-sales.js) records `creating` before POST and asks for manual lookup after an uncertain result.

In the synthetic contract, a marker containing operation ID plus a hash of trusted profile and reviewed request hash is written into the deal description. The provider treats a create response as evidence only after `GET /crm/deals/{id}` returns the same marker and reviewed title/description. After a timeout, reconciliation scans every page in an injected profile-scoped status set, accepts exactly one compatible marker, then verifies that deal by ID. A missing marker, changed fields, multiple matches, failed read, incomplete status set, or page cap leaves `unknown`; no retry POST occurs. This does not prove that real Weeek search is reliable, that a configured status set is exhaustive, or that reads are immediately consistent. Absence can never authorize another POST. The current D1 ledger also validates **synthetic** deal IDs only; real Weeek ID format and workspace uniqueness require a separate migration/identity review. Production binding remains blocked until those contracts and a full status scope are verified with a test workspace and real approval issuer.

## Ownership and integration boundary

This app owns CRM/exhibition domain APIs and data. Consumers integrate against the versioned contract rather than application internals. The existing static `flexi-consulting/exhibitions` site and `flexi-crm-automation` project are distinct sources to integrate later; this repository does not move or modify either. This slice does not connect to live D1/CRM data, write CRM records, include credentials, or contain private catalog snapshots. Live integrations, authentication, deployment, and operational recovery need separate reviewed design and implementation.

## S-01 offline MCP contract pilot

`capabilities/s01-exhibition-participants.v1.json` is the CRM-owned capability descriptor for `crm.exhibitions.participants.read@1.0.0`. It pins exact input/output/error schemas, required scope, REST operation and canonical handler binding. The published manifest refers to that descriptor. The authenticated page, REST operation and local offline MCP round-trip converge on `readExhibitionParticipants`; exhibition and participant IDs/details are joined in the same response while qualification overlays are profile-private.

`src/offline-mcp.js` implements a deliberately test-only in-process JSON-RPC client/server round-trip (`initialize`, `tools/list`, `tools/call`) backed by the real handler and the stateful synthetic fixture used by the REST server. It is not a production MCP transport or registry and does not contact Agent Run. CI checks descriptor/schema binding, same-profile API/MCP parity, state changes, profile overlay isolation, invalid tool/version/arguments, auth denial and that no Agent Run dependency is imported. The local test resolver is injected; production identity, actual VM relay, deployed MCP negotiation, live data/provider fidelity, integration acceptance and production readiness remain unverified. Offline success is not evidence of those states.

## S-04 synthetic deal contract exercise

`capabilities/s04-deals.v1.json` describes create, read, reconcile and catalog-link repair over one profile-owned domain service. `src/s04-deals.js` exercises these methods through a test-only in-process MCP JSON-RPC adapter; the REST routes use the same injected service in the contract tests. The descriptor is deliberately absent from the published manifest until human confirmation provenance, trusted production identity and relay authorization are implemented.

The in-memory operation ledger reserves a participant by `(profile, exhibition, company)` before provider dispatch, including when separate requests use different idempotency keys. An uncertain provider result keeps the reservation and must be reconciled. A validated synthetic deal ID can be linked once to the canonical local prelead timeline as a `deal_linked` event; a failed link is repaired without creating another deal. HTTP `GET /api/v1/deal-operations/{operationId}` reads this same profile-owned state. These tests use only invented profiles and a fake provider. Process restart loses all data. Real Weeek receipt correlation and field mapping, durable uniqueness, browser review/confirmation, live catalog status ownership and production transport are separate gates before real writes.

The next synthetic review boundary uses `POST /api/v1/deal-reviews` and `GET /api/v1/deal-reviews/{reviewId}` to present a revision-bound snapshot. It includes the seven legacy required deal fields: stage ID, title, source, type, INN, comment and contact. The stage ID is resolved from the synthetic profile's `Лид` binding; source is the selected exhibition; type is `direct`; notes from the profile-owned prelead timeline are copied into the reviewed comment. A changed timeline invalidates an unconfirmed review. `POST /api/v1/deal-reviews/{reviewId}/confirm` needs a receipt from the injected trusted resolver matching profile, review ID and revision. The body can supply only the revision. The offline MCP create tool likewise accepts only review ID and revision and gets the receipt from its injected trusted resolver. A model-authored `confirmation: true` is never accepted by either reviewed path. The prior direct synthetic `/api/v1/deals/confirm` route is disabled by default and can only be enabled explicitly for the legacy unit tests. This remains an offline contract exercise: a real human approval issuer, durable receipts/ledger and production identity binding do not exist yet.
