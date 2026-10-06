# S-03 built prelead rejection and undo on app-owned D1

The opt-in local Worker now records `rejection_added` and `rejection_undone` beside built participant notes in the app-owned D1 prelead journal. HTTP `POST /api/v1/preleads/{preleadId}/events` and the test-only MCP tools `crm_built_prelead_reject` / `crm_built_prelead_rejection_undo` call the same D1 methods. The capability descriptor adds the two methods to its offline v1 surface.

Each operation ID deterministically names one event. D1 batch inserts the event and advances the prelead revision together; a replay returns the existing event, and a changed payload conflicts. A rejection requires no active rejection; an undo names the latest active rejection. An unknown or created deal operation blocks a new rejection or undo so the prelead cannot claim to be rejected while a provider write may have happened. Rejection changes the prelead revision and makes a prepared deal review stale; undo requires a fresh review before confirmation.

The local Worker test covers HTTP/MCP parity, two profiles, restart, idempotency, invalid undo, stale review, and unknown deal outcome. It uses synthetic builds and a fake provider. No trusted production profile issuer, real catalog data, live Weeek write, deployed D1 binding or browser acceptance is supplied by this slice.
