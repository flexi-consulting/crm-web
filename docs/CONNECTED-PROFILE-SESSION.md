# Connected CRM profile session, offline read slice

This opt-in adapter consumes the Control Plane [identity v1 contract](https://github.com/trained-assist/trained-assist-control-plane/pull/91) at source revision `a455214645f2a5a05207e8a6ea1ea6ad0215476f`. The exact contract and response schema are copied to `contracts/connected-app-identity-v1/` and SHA-pinned in `source.json` for offline compliance checks. PR #91 is still draft; the production Worker has no trusted Agent profile authority, so no live browser issuance exists.

`createConnectedCrmD1ReadHandler` accepts a registered-service `introspect({token, audience})` port and an expected HTTPS issuer. It is disabled by default. On every allowed GET it requires a bearer token, requests introspection for `crm-web`, checks the full active response and current time, then passes the returned profile to the existing D1 domain handler. It never accepts a browser profile ID, old web cookie or Agent Run token as identity. The adapter translates `crm.catalog.read` only to the existing catalog read scope and `crm.deals.read` only to the existing deal review/operation read scopes. Its route allowlist denies all mutations before the D1 handler is called. `crm.notes.read` has no route in this slice.

The direct adapter routes remain read-only: S-01 catalog/build participant reads and S-04 review/operation reads. `POST` review, confirm, reconcile and repair are not exposed through `createConnectedCrmD1ReadHandler`. Tests use invented tokens, profiles, catalogs and deals; the synthetic D1 route itself remains off in the normal Node entry point.

## Remaining integration gates

### Opt-in browser BFF contract

`src/connected-browser-bff.js` adds an opt-in Fetch handler over the read adapter and S-04 browser command boundary. It follows the Control Plane #70 first-party authorization-code profile: fixed HTTPS issuer and callback, server-side `state` and PKCE S256 verifier, single-use pending transaction, code exchange with the CRM service credential, fresh introspection and an opaque `HttpOnly; Secure` app cookie. The exchanged token stays in the injected server-side store; browser requests cannot supply a bearer or profile. Browser reads validate introspection on every request. Profile switch or revocation invalidates later requests; introspection outage gives 503. Logout and deal commands require exact same-origin CSRF protection. The callback returns to one fixed origin, never to a browser-supplied URL. Redirects on service calls are disabled.

The included memory store is a disposable test fixture. A deployed Worker needs an atomic, durable pending/session store, a real registered CRM credential and exact redirect, the Control Plane platform-session resolver, and an ingress that strips authorization codes and bearer values from logs. The app-owned S-04 D1 browser path and actual Weeek HTTP adapter are described in [S-04 browser workflow](S-04-BROWSER-WORKFLOW.md); that offline slice does not establish CP scope registration or live provider authorization.

- A real Control Plane issuer/introspection service with registered CRM service authentication, one-time browser handoff and live session/profile revocation.
- A reviewed old `USER_ID` → agent principal/profile authority export. The current private CRM audit has no approved bindings, so no real catalog or note may be assigned by path/name coincidence.
- A final private source delta and catalog/notes import with profile and source-revision receipts before any old link routes are switched.
- The pinned offline identity contract lists `crm.deals.create` separately from catalog/deal read. This contract grant does not create a live membership or enable a route; the confirmation path remains fail-closed unless a separately reviewed trusted approval receipt issuer is injected. A create scope or browser POST is not itself approval.
- A reviewed profile-to-Weeek credential/status binding and disposable Weeek workspace evidence for create permissions, marker preservation, exhaustive status scans and read consistency.
- A dedicated CRM Web D1 binding with ordered migrations and an owner-reviewed route canary; never apply these migrations to the legacy deal-bot database.
- Browser cookie/handoff design, deployed MCP service binding, S-01 route parity and no-GCP cutover proof. None is claimed by the offline tests.
