# Profile-free exhibition facts publication gate

The old generated HTML combined public-looking participant facts with enrichment,
internal qualification, contact data, notes/status requests and deal links. The
private frozen capture verifies exact HTML bytes, but its manifest records local
paths and SHA-256 only. It does **not** establish the public source URL, a source
licence, permission to republish, or whether a company name identifies a person.
No frozen catalog is approved for this route yet.

This optional route is separate from CRM's selected-profile catalog and S-04 deal
flow. It can publish only a reviewed immutable projection: event key/title and
participant `id`, `name`, `stand`. The ID is derived from the exact source byte
receipt and row position solely for stable display within that projection. It
is not a legacy company ID, note key, deal link, or cross-profile binding.
Email, phone, contact, revenue, INN, classifications, source links, notes and
deal status are omitted. No old `USER_ID`, browser identity or MCP scope is read.

The private preparation function requires:

1. A verified owner-only backup and exact deployed-HTML source path/SHA-256.
2. A separate publication decision naming the event, its first-party public
   source URL, a HTTPS rights-evidence URL and two distinct reviewers. The
   reviewers must inspect names for personal/contact data before approval.
3. A projection SHA-256, pinned by the runtime's own configuration. The runtime
   recalculates it on startup; mismatch prevents serving any catalog.

These fields are a review gate, not a cryptographic proof of legal rights. The
operator must establish that the publisher can reuse the material and that the
rights evidence actually applies to the exact catalog. No source URL, rights
evidence or signed decision is present in the frozen manifest today. Until that
evidence exists, do not prepare or configure a real catalog.

`createPublicExhibitionReadHandler` is disabled by default and has no production
entrypoint or database binding. When explicitly enabled with reviewed snapshots,
it serves `GET /public/exhibitions`, `GET /public/exhibitions/{eventKey}` and
`GET /exhibitions/{eventKey}`. The HTML and JSON come from the same immutable
projection. Every other method or query is denied. The browser page contains no
calls to the legacy notes API, no deal controls and no user identity.

Synthetic tests build a private capture with intentionally duplicated legacy IDs
and contact/deal fields, verify only the three public fields survive, and exercise
the actual Fetch handler. They do not prove any real exhibition is publishable or
that the production route has been cut over.
