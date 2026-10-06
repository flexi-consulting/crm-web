# Legacy CRM profile identity audit

The old sales skill resolves `~/users/<USER_ID>` from an environment variable (`trained-assist-sales-skill/src/mcp-skills/expo-paths.js`). The new Runner resolves `profileId` from an authenticated principal (`ai-agent-runner/src/api/auth.ts`). These are different namespaces. A matching spelling, user directory, catalog URL, `site_<event>_<company>` key, or current EX row is not proof that the new profile owns the old catalog or note.

This offline audit accepts four owner-only JSON inputs: the verified frozen catalog capture manifest, a pinned **agent authority export** in the Runner key-registry shape (`schemaVersion: 1`, `principals`), an explicit migration mapping, and the previously reviewed exact current-catalog note candidates. The mapping pins SHA-256 of each of the other three byte files, names a legacy owner, target principal/profile pair and separate reviewed evidence reference/hash for each binding. The CLI rejects changed bytes, missing bindings, contradictory principal profiles, many old owners assigned to one target profile, changed HTML source revisions and note profile mismatches. It writes only aggregate counts and receipt hashes to a private `0600` report outside Git. No API, D1 or Weeek call is made.

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

At the time of this slice, the private migration folder contains the 19-catalog capture and 152-note correlation artifacts, but no authoritative old `USER_ID`→new principal/profile export. A production dry-run cannot report approved mappings from those artifacts alone. Generate a private export from the agent profile authority, record its SHA-256, and review old namespace evidence with its owner before filling bindings. The historical-only catalogs and uncertain notes remain quarantined.
