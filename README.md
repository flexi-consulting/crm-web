# CRM Web

Independent CRM and exhibitions web service. This work is a local synthetic API/domain-logic foundation. Catalog and company reads use fixtures; the sales extension prepares only in-memory synthetic deal intents and does not create a CRM deal. It exposes a versioned HTTP contract, but the deal-intent capability is not safe for agent registration yet.

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
- `GET /api/v1/companies` and `/api/v1/companies/{id}` return invented company fixtures visible to the resolved profile.
- `POST /api/v1/deal-intents` prepares an in-memory synthetic pre-deal intent using an `Idempotency-Key`; `GET /api/v1/deal-intents/{id}` reads the profile-owned intent and reconciles its status through the fake Weeek adapter. This is not confirmed deal creation. Reconciliation is a status read and does not replay the preparation operation.
- Other paths return JSON 404. Non-GET/HEAD methods are rejected with 405.

JSON Schemas live in `schemas/`, including typed request/response schemas for the synthetic deal-intent boundary and all four C14 readiness states. `CRM_WEB_RELEASE_VERSION`, `CRM_WEB_SOURCE_REVISION`, and `CRM_WEB_ENVIRONMENT` can identify a built release; local defaults are `0.1.0`, `working-tree`, and `development`. `npm test` runs HTTP behavior and contract/schema checks on Node's built-in test runner; CI runs the same check.

Profile-scoped company and deal-intent routes require a trusted-profile resolver injected into `createServer`. It must supply profile identity and granted scopes separately; each operation enforces its least-privilege `requiredScopes`. No production resolver is configured in this slice, so those routes fail closed with 503 by default; tests inject a synthetic resolver to verify profile isolation and 403 scope denial. The request body contains no profile identity or scopes. The fake Weeek adapter, company ownership assignments, and intent store are process-local synthetic fixtures; none writes CRM/Weeek data or survives restart.

This PR is an API/domain-logic foundation only: it adds no browser create-deal flow and does not establish actual agent relay parity. It is not S-04 complete, and its intent-preparation capability must not be registered for agent use until user confirmation and a real provider receipt/reconciliation flow exist. Canonical company ownership and the platform source for trusted profile context/scopes remain integration decisions.

The manifest follows the proposed [C14 connected application contract](https://github.com/trained-assist/trained-agent-architecture/blob/refs/pull/150/head/contracts/C14-CONNECTED-APPLICATION.md); runtime registration, compatibility negotiation, and authenticated platform readiness are not implemented here.

## Ownership and integration boundary

This app owns CRM/exhibition domain APIs and data. Consumers integrate against the versioned contract rather than application internals. The existing static `flexi-consulting/exhibitions` site and `flexi-crm-automation` project are distinct sources to integrate later; this repository does not move or modify either. This slice does not connect to live D1/CRM data, write CRM records, include credentials, or contain private catalog snapshots. Live integrations, authentication, deployment, and operational recovery need separate reviewed design and implementation.
