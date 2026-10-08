# S-04 browser deal creation

This opt-in slice adds a human-confirmed deal path from a profile-owned exhibition participant. It uses the existing S-04 domain review service, D1 operation ledger, marker-based Weeek correlation provider and fixed-origin Weeek HTTP adapter. The browser never supplies a trusted profile, provider token, status ID or approval receipt.

## User path

1. A participant card links to `/catalogs/{buildId}/participants/{companyId}/deal`. The app requests the dedicated `crm.deals.create` Control Plane scope for that path.
2. The user supplies the contact and comment. `POST /deal-workflow/prepare` calls the canonical `POST /api/v1/deal-reviews` handler and stores a revision-bound review in D1; it has no provider side effect.
3. The review page displays the precise fields that will be sent to Weeek. The first same-origin, CSRF-protected `POST /deal-workflow/confirm` asks Control Plane to prepare a one-use approval intent bound to the current app token, profile, operation payload and review revision. CRM durably stores the intent pointer and shows a link to the exact Control Plane review page; no Weeek request is sent. The user reviews and approves there, returns to CRM, and submits the separate CSRF-protected create command. CRM consumes the typed Control Plane receipt before the canonical D1 confirmation handler can reserve a provider operation. A pending human approval returns the review link, while Control Plane or durable-store failures fail closed. Once the provider operation is durably reserved, retries reconcile it without requiring a still-live approval intent or sending a second create POST.
4. D1 atomically reserves the review/receipt/operation before the real HTTP adapter may issue one Weeek POST. A confirmed and verified response advances the durable operation and participant link atomically.
5. A timeout stays `unknown`. The result page offers `POST /deal-workflow/reconcile`, which calls Weeek list/detail GETs and checks the exact correlation marker. Resubmitting confirmation for an existing operation takes a read-only reconcile/result path before requiring a new receipt. Neither route may issue a second create POST.

JSON clients use the same BFF session and CSRF boundary with `POST /api/v1/deal-reviews`, `POST /api/v1/deal-reviews/{reviewId}/confirm`, and `POST /api/v1/deal-operations/{operationId}/reconcile`. The latter two commands require explicit current `Origin` and `x-csrf-token` values. Domain validation and D1 ownership checks remain in the canonical handler.

## Offline evidence

The Worker Fetch test applies migrations to disposable D1, seeds one invented catalog participant, performs the code+PKCE handoff, prepares a review, checks origin/CSRF failures, confirms through the D1 handler and actual `WeeekHttpTransport`, then makes the controlled provider accept the POST and drop its response. It restarts the Worker, runs the browser reconciliation action, verifies one provider deal and a durable `created`/`linked` operation, and resubmits the confirmation. The provider fixture records exactly one POST; list/detail GETs resolve the marker. Tests make no external network call, read no private CRM capture and write no production Weeek data.

Migrations `0007_connected_browser_s04_commands.sql` and `0008_cp_approval_intents.sql` add the S-04 handoff mode and revision/payload-bound Control Plane intent pointer. Migration `0009_encrypt_connected_browser_secrets.sql` replaces plaintext pending PKCE/session-secret fields with ciphertext and intentionally invalidates existing pending handoffs and browser sessions; apply migrations only to the separate CRM Web D1 database. The Worker requires `CRM_CONNECTED_BFF_ENCRYPTION_KEY` as a 64-character lowercase hex secret (32 random bytes); a missing or changed key fails closed.

## Live gates

- The CRM Worker now calls the Control Plane prepare/consume approval endpoints using its registered service credential and the current server-held app token. CP's opt-in receipt implementation is in draft [#85](https://github.com/trained-assist/trained-assist-control-plane/pull/85); the write-scope vocabulary is in draft [#80](https://github.com/trained-assist/trained-assist-control-plane/pull/80). Neither is merged, deployed or configured for a live CRM session.
- Verify the live platform membership resolver binds the approving principal to the selected profile, and that the Control Plane receipt issuer enforces one-use confirmation of the exact payload/revision.
- Supply a private, profile-bound Weeek credential resolver and reviewed workspace/status binding. Verify the full writable status set, API permissions, opaque deal ID, description marker preservation, list/detail read consistency and timeout-after-accept reconciliation in a disposable Weeek workspace.
- Apply the ordered migrations to a dedicated app-owned D1 binding, verify its identity and recovery/rollback, and complete a private synthetic canary before route activation. Legacy catalog import and old deal/notes ownership remain separately gated by CRM migration issue #3.

The fixture exercises the same prepare/consume HTTP protocol against a local Control Plane stub, the real CRM route handlers and durable D1 intent storage; it does not mint approval from a browser header. This does not prove Control Plane deployment, production membership resolution, Weeek's live read consistency, a complete workspace scan or authorization to switch the public route.

## Disposable public browser sandbox

For manual acceptance through a Cloudflare Quick Tunnel, run the local Worker from `test/wrangler.connected-browser-local.toml` with migrations `0001`–`0011` and `test/fixtures/weeek-http-provider.sql` applied to a fresh local persist directory. Run `scripts/sandbox-public-browser-proxy.mjs` with `CRM_SANDBOX_PUBLIC_ORIGIN=https://<quick-tunnel-host>` and point `cloudflared tunnel --url` at the proxy port. Open `/__sandbox-login` for an auto-seeded, synthetic profile and catalog. The proxy restricts fixture control routes, rewrites the fixed local origin, and replaces the CP review link with an explicit synthetic approval page that resumes the same review.

This public tunnel is development-only. The login and approval routes use invented identities and local D1/Weeek fixtures; they must never be enabled against a production Worker, database, Control Plane or Weeek workspace. Quick Tunnel URLs and local processes are temporary and have no uptime guarantee.
