# Private legacy catalog handoff

The old sales generator reads `enriched.json` (or `requisites_enrichment.json` / `targets.json`) from an expo project's `data/` or legacy `expo-pipeline/<event>/`. It publishes `index.html` under `deploy/<event>/` or the legacy expo directory. That HTML contains the final `EX` array and `EVENT_KEY`; copying JSON inputs alone cannot prove what visitors saw.

Read-only GCP inventory on 2026-10-06, with no names or contact data extracted into this repository:

| Item | Count |
| --- | ---: |
| Profile directories | 40 |
| Candidate expo data directories | 25 |
| Deployed HTML with parseable `EX` | 19 |
| Total deployed `EX` rows | 4,296 |
| Duplicate ID occurrences beyond first | 31 |
| IDs unsafe under the old link rule | 192 |
| `enriched.json` | 10 files / 1,004 rows |
| `ex-array.json` | 3 files / 216 rows |
| `exhibitors.json` | 3 files / 388 rows |
| `targets.json` | 3 files / 120 rows |
| `requisites_enrichment.json` | 2 files / 191 rows |
| Named source JSON bytes, combined | 1,334,102 |
| Deployed HTML bytes, combined | 3,895,193 |

The old VM was `TERMINATED` by 2026-10-06 05:46 UTC. The operator restarted
it for migration and froze the agent writers; a disk snapshot reached `READY`.
The private handoff CLI then captured all 40 discovered files from the frozen
source (5,229,295 bytes). Source and transferred owner-only backup both passed
verification with the same manifest SHA-256 receipt. This proves the captured
catalog byte set, not the completeness of other sales stores or notes D1.
Keep the private receipt and backup outside Git. If the old writers resume,
compare subsequent changes before claiming final cutover parity.

Run `node scripts/legacy-ex-handoff.mjs capture SOURCE_USERS_ROOT NEW_PRIVATE_DIR` on a private filesystem. The tool discovers the exact known layouts, copies every deployed HTML and named source JSON byte for byte into content-addressed objects, and writes owner-only `manifest.json` with source path, byte count and SHA-256. `identity-quarantine.json` is private and lists duplicate/unsafe IDs with row indexes. Console output contains aggregate counts and a manifest SHA-256, never private rows. Record that digest on the source and compare it with the `verify PRIVATE_DIR` digest after transfer; verification also checks every object and the quarantine report. A modified or missing byte fails the receipt.
The capture directory and private mapping file must live outside every Git worktree; the CLI rejects paths inside one.

`restore-local PRIVATE_DIR PRIVATE_MAPPING_JSON http://127.0.0.1:PORT/` targets only the opt-in local CRM Web Worker/D1 contract fixture. The private mapping must name every captured HTML by its source path and SHA-256, state a trusted target profile and matching event key, and resolve every conflicting row index. For a duplicate safe ID, exactly one row must keep the original ID; the operator assigns distinct safe IDs to the others. Unsafe IDs require safe replacements. Preflight verifies all captured bytes and all mappings before sending the first catalog to D1. Successful D1 replies must match the projected build ID and source revision. This does not install or deploy a Worker.

Private mapping example with invented values:

```json
{
  "version": 1,
  "catalogs": [{
    "sourcePath": "invented-profile/projects/invented-project/deploy/invented-expo-2026/index.html",
    "sourceSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "profileRef": "demo-profile-a",
    "eventKey": "invented-expo-2026",
    "resolutions": { "0": "LNG001", "1": "LNG002", "2": "CYR011" }
  }]
}
```

The backup and quarantine report are private data. Never commit them, the mapping, source snapshots or derived SQL to this public repository. The `EX` import only handles catalog facts and legacy target flags. The old catalog's `/api/site-predeal-notes` calls point to the separate `flexi-site-notes` Worker. The Telegram deal bot reads and writes preleads in the same legacy D1 database, including `preleads` and `prelead_messages`; its notes, rejection state and deal links are a separate required S-03/S-04 source. Capture a consistent private backup of that shared D1 and reconcile these records before any route cutover. Production D1 identity/approval issuance, old URL routing and browser parity remain open.
