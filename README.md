# CRM Web

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
- S-04 foundation routes `POST /api/v1/deals/confirm`, `POST /api/v1/deal-operations/{operationId}/reconcile`, and `POST /api/v1/deal-operations/{operationId}/repair` exercise a `confirmation: true` caller assertion, required synthetic deal fields, profile-scoped idempotency, and an in-memory `pending` / `created` / `unknown` / `rejected` ledger through a fake provider. The boolean is not evidence of human intent or authenticated session provenance; those mechanisms remain unresolved. A `created` result requires a validated synthetic deal ID. An `unknown` result must reconcile before another create attempt; repair only restores the synthetic link and does not create a deal. Schemas are `synthetic-confirmed-deal-request`, `synthetic-deal-operation`, and `synthetic-deal-operation-error`. These routes are not published capabilities.
- S-02 foundation routes `POST /api/v1/catalog-builds` and `GET /api/v1/catalog-builds/{buildId}` run synthetic source validation/import, duplicate-name removal, enrichment with provenance, registry outcomes, conservative qualification, and deterministic JSON artifact/report generation. Duplicate or unsafe source IDs block before enrichment/registry calls. Provider failures remain typed `unavailable`/`unknown` outcomes and are visible in the report. Schemas are `catalog-build-request`, `catalog-build-artifact`, `catalog-build-report`, `catalog-build-response`, and `catalog-build-error`. Routes require an injected profile resolver and are not published capabilities.
- `POST /api/v1/catalog-builds/{buildId}/preview` and `GET /api/v1/catalog-previews/{previewId}` render a deterministic, in-memory HTML preview from a validated synthetic artifact. The descriptor binds preview ID to build ID, source revision, and renderer revision, and carries a markup validation report. Text is HTML-escaped; links are revalidated as HTTP(S); the page is marked `noindex`, sets a restrictive CSP, and has inert local search/filter behavior only. It does not publish or deploy. Schemas are `catalog-preview-response`, `catalog-preview-report`, and `catalog-preview-error`.
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

## Ownership and integration boundary

This app owns CRM/exhibition domain APIs and data. Consumers integrate against the versioned contract rather than application internals. The existing static `flexi-consulting/exhibitions` site and `flexi-crm-automation` project are distinct sources to integrate later; this repository does not move or modify either. This slice does not connect to live D1/CRM data, write CRM records, include credentials, or contain private catalog snapshots. Live integrations, authentication, deployment, and operational recovery need separate reviewed design and implementation.

## S-01 offline MCP contract pilot

`capabilities/s01-exhibition-participants.v1.json` is the CRM-owned capability descriptor for `crm.exhibitions.participants.read@1.0.0`. It pins exact input/output/error schemas, required scope, REST operation and canonical handler binding. The published manifest refers to that descriptor. The authenticated page, REST operation and local offline MCP round-trip converge on `readExhibitionParticipants`; exhibition and participant IDs/details are joined in the same response while qualification overlays are profile-private.

`src/offline-mcp.js` implements a deliberately test-only in-process JSON-RPC client/server round-trip (`initialize`, `tools/list`, `tools/call`) backed by the real handler and the stateful synthetic fixture used by the REST server. It is not a production MCP transport or registry and does not contact Agent Run. CI checks descriptor/schema binding, same-profile API/MCP parity, state changes, profile overlay isolation, invalid tool/version/arguments, auth denial and that no Agent Run dependency is imported. The local test resolver is injected; production identity, actual VM relay, deployed MCP negotiation, live data/provider fidelity, integration acceptance and production readiness remain unverified. Offline success is not evidence of those states.
