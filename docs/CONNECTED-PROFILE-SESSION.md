# Connected CRM profile session, offline read slice

This opt-in adapter consumes the Control Plane [identity v1 contract](https://github.com/trained-assist/trained-assist-control-plane/pull/66) at source revision `d5012dfc3b1ef41674f52efa7bd26a8b38c43850`. The exact contract and response schema are copied to `contracts/connected-app-identity-v1/` for offline compliance checks. The Control Plane PR currently defines a test-only issuer model; no live token endpoint or browser code exchange exists.

`createConnectedCrmD1ReadHandler` accepts a registered-service `introspect({token, audience})` port and an expected HTTPS issuer. It is disabled by default. On every allowed GET it requires a bearer token, requests introspection for `crm-web`, checks the full active response and current time, then passes the returned profile to the existing D1 domain handler. It never accepts a browser profile ID, old web cookie or Agent Run token as identity. The adapter translates `crm.catalog.read` only to the existing catalog read scope and `crm.deals.read` only to the existing deal review/operation read scopes. Its route allowlist denies all mutations before the D1 handler is called. `crm.notes.read` has no route in this slice.

The visible S-01 routes are `GET /catalogs/{buildId}`, its participant card, and the matching `/api/v1/catalog-builds/{buildId}` participant reads. The S-04 routes are review and operation status GETs only. `POST` review, confirm, reconcile and repair are not exposed through this adapter. A read grant is not a deal creation grant. Tests use invented tokens, profiles, catalogs and deals; the synthetic D1 route itself remains off in the normal Node entry point.

## Remaining integration gates

- A real Control Plane issuer/introspection service with registered CRM service authentication, one-time browser handoff and live session/profile revocation.
- A reviewed old `USER_ID` → agent principal/profile authority export. The current private CRM audit has no approved bindings, so no real catalog or note may be assigned by path/name coincidence.
- A final private source delta and catalog/notes import with profile and source-revision receipts before any old link routes are switched.
- A separate S-04 write contract with explicit confirmation provenance, canonical writer, durable ledger, Weeek reconciliation and a test-account canary. This read adapter cannot supply that authority.
- Browser cookie/handoff design, deployed MCP service binding, S-01 route parity and no-GCP cutover proof. None is claimed by the offline tests.
