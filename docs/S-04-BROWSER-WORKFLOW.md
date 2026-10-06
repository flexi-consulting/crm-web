# S-04 browser deal creation

This opt-in slice adds a human-confirmed deal path from a profile-owned exhibition participant. It uses the existing S-04 domain review service, D1 operation ledger, marker-based Weeek correlation provider and fixed-origin Weeek HTTP adapter. The browser never supplies a trusted profile, provider token, status ID or approval receipt.

## User path

1. A participant card links to `/catalogs/{buildId}/participants/{companyId}/deal`. The app requests the dedicated `crm.deals.create` Control Plane scope for that path.
2. The user supplies the contact and comment. `POST /deal-workflow/prepare` calls the canonical `POST /api/v1/deal-reviews` handler and stores a revision-bound review in D1; it has no provider side effect.
3. The review page displays the precise fields that will be sent to Weeek. A separate `POST /deal-workflow/confirm` requires the same-origin `Origin`, the current app session and its CSRF token. The Worker asks an injected trusted approval issuer for a receipt bound to the current principal/profile, review and revision, then calls the canonical D1 confirmation handler. The create scope and browser POST do not mint approval. With no issuer configured, the route returns a fail-closed error and sends no Weeek POST.
4. D1 atomically reserves the review/receipt/operation before the real HTTP adapter may issue one Weeek POST. A confirmed and verified response advances the durable operation and participant link atomically.
5. A timeout stays `unknown`. The result page offers `POST /deal-workflow/reconcile`, which calls Weeek list/detail GETs and checks the exact correlation marker. Resubmitting confirmation for an existing operation takes a read-only reconcile/result path before requiring a new receipt. Neither route may issue a second create POST.

JSON clients use the same BFF session and CSRF boundary with `POST /api/v1/deal-reviews`, `POST /api/v1/deal-reviews/{reviewId}/confirm`, and `POST /api/v1/deal-operations/{operationId}/reconcile`. The latter two commands require explicit current `Origin` and `x-csrf-token` values. Domain validation and D1 ownership checks remain in the canonical handler.

## Offline evidence

The Worker Fetch test applies migrations to disposable D1, seeds one invented catalog participant, performs the code+PKCE handoff, prepares a review, checks origin/CSRF failures, confirms through the D1 handler and actual `WeeekHttpTransport`, then makes the controlled provider accept the POST and drop its response. It restarts the Worker, runs the browser reconciliation action, verifies one provider deal and a durable `created`/`linked` operation, and resubmits the confirmation. The provider fixture records exactly one POST; list/detail GETs resolve the marker. Tests make no external network call, read no private CRM capture and write no production Weeek data.

Migration `0007_connected_browser_s04_commands.sql` expands the app-owned pending handoff mode constraint. Existing and pending sessions remain unchanged; pending transactions with unknown modes still fail closed. Apply it only to the separate CRM Web D1 database.

## Live gates

- The pinned Control Plane identity contract currently lists CRM read scopes only. `crm.deals.create` and the browser-issued approval receipt need an accepted registered-app contract and reviewed grants before a real session can receive them.
- Review the actor/profile membership and the issuer meaning of the human confirmation receipt.
- Supply a private, profile-bound Weeek credential resolver and reviewed workspace/status binding. Verify the full writable status set, API permissions, opaque deal ID, description marker preservation, list/detail read consistency and timeout-after-accept reconciliation in a disposable Weeek workspace.
- Apply the ordered migrations to a dedicated app-owned D1 binding, verify its identity and recovery/rollback, and complete a private synthetic canary before route activation. Legacy catalog import and old deal/notes ownership remain separately gated by CRM migration issue #3.

The fixture proves the app protocol and failure handling. Its explicitly named synthetic approval issuer is used only to exercise the accepted path; the production Worker has no default issuer and fails closed. This does not prove Control Plane scope registration, a reviewed production approval issuer, production ownership, Weeek's live read consistency, a complete workspace scan or authorization to switch the public route.
