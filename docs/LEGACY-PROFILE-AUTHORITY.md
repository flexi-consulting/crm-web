# Legacy CRM profile identity audit

The old sales skill resolves `~/users/<USER_ID>` from an environment variable (`trained-assist-sales-skill/src/mcp-skills/expo-paths.js`). The new Runner resolves `profileId` from an authenticated principal (`ai-agent-runner/src/api/auth.ts`). These are different namespaces. A matching spelling, user directory, catalog URL, `site_<event>_<company>` key, or current EX row is not proof that the new profile owns the old catalog or note.

This offline audit accepts four owner-only JSON inputs: the verified frozen catalog capture manifest, a pinned **principal/profile compatibility export** in the Runner key-registry shape (`schemaVersion: 1`, `principals`), an explicit migration mapping, and the previously reviewed exact current-catalog note candidates. The mapping pins SHA-256 of each of the other three byte files, names a legacy owner, target principal/profile pair and separate reviewed evidence reference/hash for each binding. The CLI rejects changed bytes, missing bindings, contradictory principal profiles, many old owners assigned to one target profile, changed HTML source revisions and note profile mismatches. It writes only aggregate counts and receipt hashes to a private `0600` report outside Git. No API, D1 or Weeek call is made. **The Runner key registry authenticates execution API keys and is not the Control Plane's selected-profile authority**; a structurally valid export cannot approve a migration.

Invented mapping shape:

```json
{
  "version": 1,
  "manifestSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "authoritySha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "notesSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "bindings": [{
    "legacyUserId": "invented-legacy-owner",
    "principalId": "invented-principal",
    "profileId": "invented-profile",
    "evidenceRef": "reviewed-profile-migration-record",
    "evidenceSha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
  }]
}
```

Run `node scripts/legacy-profile-authority.mjs PRIVATE_MANIFEST PRIVATE_AGENT_AUTHORITY PRIVATE_MAPPING PRIVATE_NOTE_CANDIDATES NEW_PRIVATE_REPORT`. Keep all five files outside a Git worktree. The private source capture is verified separately with `legacy-ex-handoff verify`; this audit checks the pinned manifest bytes, not every backup object again.

`catalogBindingCandidates` and `noteBindingCandidates` mean that the supplied sources agree structurally. The audit always returns `approvedForImport: false`. Evidence references are operator assertions, not cryptographic proof of legacy ownership. Before any import or live read, the platform profile owner must issue or verify the old→new binding, the connected app must use the versioned trusted issuer/introspection handoff for live requests, and the catalog owner must approve exact revision and duplicate/unsafe ID resolutions. The 152 legacy preleads still need independent event/company/revision matching and per-record disposition. A structural candidate is never an automatic note link.

At the time of this slice, the private migration folder contains the 19-catalog capture and 152-note correlation artifacts, but no authoritative old `USER_ID`→new principal/profile export. All 59 exact current-catalog note candidates currently have no `trustedProfileRef` in the private reviewed-candidate file; that is a missing authority claim, not a mapping result. A production dry-run cannot report approved mappings from those artifacts alone. Generate a private export from the agent profile authority, record its SHA-256, and review old namespace evidence with its owner before filling bindings or separately reviewing the note candidates. The historical-only catalogs and uncertain notes remain quarantined.

## Exact source investigation, 2026-10-06

- The frozen private capture manifest has SHA-256 `aab34fe6381938bad0b5435a5dda8c09bdb13f93e402c2b7c5da40afbf474680`, 40 records: 19 `deployed_html` and 21 `source_json`. Its `identity-quarantine.json` lists 19 catalogs. The capture folder has no file named as an authority, mapping, principal or profile export. These are source-inventory facts, not owner proof.
- The old sales path resolves `~/users/<USER_ID>` from an environment variable (`trained-assist-sales-skill/src/mcp-skills/expo-paths.js`). The old agent's `src/web-auth.js` signs a JWT whose `sub` is its own `username`; its `web_current` cookie selects one of its local profiles. Its `src/action-transport.js` treats the legacy `profileId` as that username. This establishes the old namespace only.
- The new Runner key registry (`ai-agent-runner/src/api/auth.ts`) binds execution API key hashes to `principalId` and `profileId`. The Control Plane `admission_principals` table (`trained-assist-control-plane/migrations/0002_task_admission.sql`) binds a CP principal to a profile for task authorization. Neither schema contains the old sales `USER_ID`. Control Plane connected-app identity v1 (#66) has no live issuer/browser handoff yet. No verified crosswalk can be derived from these sources.

## Minimal private reviewer workflow

1. Keep the frozen manifest and all outputs outside Git. Verify the manifest's byte hash against the source capture receipt, then run `node scripts/legacy-profile-review-packet.mjs PRIVATE_MANIFEST EXPECTED_SHA256 NEW_PRIVATE_PACKET`. The CLI refuses a mismatched receipt and writes a `0600`, create-once packet. It groups exact catalog source paths and object hashes by old owner, with every proposed principal/profile empty and `approvedForImport: false`.
2. For each old owner, the owner of the old account proves control of that account through a fresh authenticated challenge or a separately reviewed migration record. A path, username string, legacy JWT payload, catalog link or `.chatid` file alone is insufficient. Record a private evidence artifact and its hash; unresolved owners remain `pending`.
3. The Control Plane profile authority owner independently confirms the current enabled principal, selected profile and delegation allowed for `crm-web`, and signs or approves a versioned private export. Record its source revision, timestamp, byte hash and reviewer. A Runner key-registry row can be a cross-check only. Detect many-to-one, disabled, switched or conflicting profile bindings before any import.
4. A second reviewer checks each proposed old owner against both evidence artifacts and each frozen catalog object hash. They create the explicit mapping file for the existing `legacy-profile-authority.mjs` audit, pinning manifest, authority export and exact note-candidate byte hashes. The audit remains `approvedForImport: false`; approval of import needs a separate decision after current catalog and per-note source revision review.
5. Keep 19 catalogs and the 59 exact current-catalog note candidates quarantined until these checks pass. Separately resolve historical-only and ambiguous notes. Never derive `trustedProfileRef` from the old path or from a matching textual profile name.
