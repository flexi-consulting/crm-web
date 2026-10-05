# CRM Web

Independent CRM and exhibitions web service. This first slice is deliberately local, read-only, and backed only by clearly synthetic fixtures. It exposes a versioned HTTP contract for consumers such as the agent; the application owns its domain API and data model.

## Run locally

Requires Node.js 20 or newer.

```sh
npm start
```

Open `http://127.0.0.1:3000`. The UI displays invented catalog entries and identifies them as synthetic.

## Contract v1

- `GET /api/v1/manifest` returns stable `serviceId`, release version/source revision/environment, platform contract range, domain API version, typed capabilities, schema references, effects/scopes, compatibility data, and endpoint references.
- `GET /api/v1/readiness` reports `ready` for this local process and includes its checked version tuple. Its scope is explicitly `local_process_only`; it does not probe providers, credentials, or external dependencies and is not proof of platform binding readiness.
- `GET /api/v1/catalog` returns the synthetic catalog; optional `q` searches name, city, and country.
- Other paths return JSON 404. Non-GET/HEAD methods are rejected with 405.

JSON Schemas live in `schemas/`, including the four C14 readiness states. `CRM_WEB_RELEASE_VERSION`, `CRM_WEB_SOURCE_REVISION`, and `CRM_WEB_ENVIRONMENT` can identify a built release; local defaults are `0.1.0`, `working-tree`, and `development`. `npm test` runs HTTP behavior and contract/schema checks on Node's built-in test runner; CI runs the same check. No real storage or upstream service is configured.

The manifest follows the proposed [C14 connected application contract](https://github.com/trained-assist/trained-agent-architecture/blob/refs/pull/150/head/contracts/C14-CONNECTED-APPLICATION.md); runtime registration, compatibility negotiation, and authenticated platform readiness are not implemented here.

## Ownership and integration boundary

This app owns CRM/exhibition domain APIs and data. Consumers integrate against the versioned contract rather than application internals. The existing static `flexi-consulting/exhibitions` site and `flexi-crm-automation` project are distinct sources to integrate later; this repository does not move or modify either. This slice does not connect to live D1/CRM data, write CRM records, include credentials, or contain private catalog snapshots. Live integrations, authentication, deployment, and operational recovery need separate reviewed design and implementation.
