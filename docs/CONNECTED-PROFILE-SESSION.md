# Connected CRM profile session, offline read slice

This opt-in adapter consumes the Control Plane [identity v1 contract](https://github.com/trained-assist/trained-assist-control-plane/pull/66) at source revision `d5012dfc3b1ef41674f52efa7bd26a8b38c43850`. The exact contract and response schema are copied to `contracts/connected-app-identity-v1/` for offline compliance checks. The Control Plane PR currently defines a test-only issuer model; no live token endpoint or browser code exchange exists.

`createConnectedCrmD1ReadHandler` accepts a registered-service `introspect({token, audience})` port and an expected HTTPS issuer. It is disabled by default. On every allowed GET it requires a bearer token, requests introspection for `crm-web`, checks the full active response and current time, then passes the returned profile to the existing D1 domain handler. It never accepts a browser profile ID, old web cookie or Agent Run token as identity. The adapter translates `crm.catalog.read` only to the existing catalog read scope and `crm.deals.read` only to the existing deal review/operation read scopes. Its route allowlist denies all mutations before the D1 handler is called. `crm.notes.read` has no route in this slice.

The visible S-01 routes are `GET /catalogs/{buildId}`, its participant card, and the matching `/api/v1/catalog-builds/{buildId}` participant reads. The S-04 routes are review and operation status GETs only. `POST` review, confirm, reconcile and repair are not exposed through this adapter. A read grant is not a deal creation grant. Tests use invented tokens, profiles, catalogs and deals; the synthetic D1 route itself remains off in the normal Node entry point.

## Remaining integration gates

### Opt-in browser BFF contract

`src/connected-browser-bff.js` adds an opt-in Fetch handler over the read adapter. It follows the Control Plane #70 first-party authorization-code profile: fixed HTTPS issuer and callback, server-side `state` and PKCE S256 verifier, single-use pending transaction, code exchange with the CRM service credential, fresh introspection and an opaque `HttpOnly; Secure` app cookie. The exchanged token stays in the injected server-side store; browser requests cannot supply a bearer or profile. Browser reads enter the existing S-01/S-04 read boundary, which validates introspection on every request. Profile switch or revocation invalidates later reads; introspection outage gives 503. Logout requires a same-origin request and CSRF token from the authenticated session endpoint, and does not depend on Control Plane availability. The callback returns to one fixed origin, never to a browser-supplied URL. Redirects on service calls are disabled.

The included memory store is a disposable test fixture. A deployed Worker needs an atomic, durable pending/session store, a real registered CRM credential and exact redirect, the Control Plane platform-session resolver, and an ingress that strips authorization codes and bearer values from logs. This PR does not mount the BFF, enable the flag, import private catalogs or authorize deal writes. A live two-profile acceptance test remains required.

- A real Control Plane issuer/introspection service with registered CRM service authentication, one-time browser handoff and live session/profile revocation.
- A reviewed old `USER_ID` → agent principal/profile authority export. The current private CRM audit has no approved bindings, so no real catalog or note may be assigned by path/name coincidence.
- A final private source delta and catalog/notes import with profile and source-revision receipts before any old link routes are switched.
- A separate S-04 write contract with explicit confirmation provenance, canonical writer, durable ledger, Weeek reconciliation and a test-account canary. This read adapter cannot supply that authority.
- Browser cookie/handoff design, deployed MCP service binding, S-01 route parity and no-GCP cutover proof. None is claimed by the offline tests.
