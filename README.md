# CRM Web

Independent CRM and exhibitions web service. This first slice is deliberately local, read-only, and backed only by clearly synthetic fixtures. It exposes a versioned HTTP contract for consumers such as the agent; the application owns its domain API and data model.

## Run locally

Requires Node.js 20 or newer.

```sh
npm start
```

Open `http://127.0.0.1:3000`. The UI displays invented catalog entries and identifies them as synthetic.

## Contract v1

- `GET /api/v1/manifest` returns the contract version, service identity, mode, and capability list.
- `GET /api/v1/readiness` reports process readiness and contract version. It does not probe external dependencies.
- `GET /api/v1/catalog` returns the synthetic catalog; optional `q` searches name, city, and country.
- Other paths return JSON 404. Non-GET/HEAD methods are rejected with 405.

JSON Schemas live in `schemas/`. `npm test` runs HTTP behavior and contract shape checks on Node's built-in test runner; CI runs the same check. No real storage or upstream service is configured.

## Ownership and integration boundary

This app owns CRM/exhibition domain APIs and data. Consumers integrate against the versioned contract rather than application internals. The existing static `flexi-consulting/exhibitions` site and `flexi-crm-automation` project are distinct sources to integrate later; this repository does not move or modify either. This slice does not connect to live D1/CRM data, write CRM records, include credentials, or contain private catalog snapshots. Live integrations, authentication, deployment, and operational recovery need separate reviewed design and implementation.
