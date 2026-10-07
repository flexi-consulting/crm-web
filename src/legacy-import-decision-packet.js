import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildLegacyProfileReviewPacket } from "./legacy-profile-review-packet.js";
import { identityQuarantine, parseLegacyExHtml, verifyLegacyCatalogBackup } from "./private-legacy-handoff.js";
import { inspectLegacyExRow, projectLegacyExSnapshot } from "./legacy-ex-snapshot.js";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

// A private, byte-bound review queue. Its synthetic projection only checks row
// structure; no field here authorizes a profile binding or a real import.
export async function buildLegacyImportDecisionPacket({ backupDir, reviewPacketPath }) {
  const manifest = await verifyLegacyCatalogBackup(backupDir);
  const reviewed = JSON.parse(await readFile(resolve(reviewPacketPath), "utf8"));
  const expected = buildLegacyProfileReviewPacket(manifest, manifest.manifestSha256);
  if (JSON.stringify(reviewed) !== JSON.stringify(expected))
    throw new Error("legacy_review_packet_mismatch");
  const bySource = new Map(manifest.records.filter((record) => record.kind === "deployed_html")
    .map((record) => [record.sourcePath, record]));
  const owners = [];
  for (const owner of expected.owners) {
    const catalogs = [];
    for (const selected of owner.catalogs) {
      const record = bySource.get(selected.sourcePath);
      const bytes = await readFile(join(resolve(backupDir), "objects", record.objectSha256));
      const parsed = parseLegacyExHtml(bytes);
      if (parsed.eventKey !== record.eventKey) throw new Error("legacy_catalog_event_mismatch");
      const conflicts = identityQuarantine(parsed.entries);
      const reasons = new Map();
      for (const group of conflicts.duplicates) for (const index of group.indices)
        reasons.set(index, ["duplicate_id"]);
      for (const item of conflicts.unsafe)
        reasons.set(item.index, [...(reasons.get(item.index) ?? []), "unsafe_id"]);
      const decisions = [...reasons].sort(([a], [b]) => a - b).map(([index, issues]) => ({
        index, rowSha256: sha(JSON.stringify(parsed.entries[index])),
        originalId: typeof parsed.entries[index]?.id === "string" ? parsed.entries[index].id : null,
        displayName: parsed.entries[index]?.n ?? null,
        booth: parsed.entries[index]?.s ?? null,
        issues, replacementId: null, reviewerEvidenceRef: null
      }));
      const fieldDecisions = parsed.entries.flatMap((row, index) => {
        const issues = inspectLegacyExRow(row);
        return issues.length ? [{ index, rowSha256: sha(JSON.stringify(row)), issues,
          reviewerDecision: null, reviewerEvidenceRef: null }] : [];
      });
      const projection = decisions.length ? "blocked_on_identity_resolution"
        : projectLegacyExSnapshot({ profileRef: "synthetic-preflight-only", eventKey: parsed.eventKey,
          entries: parsed.entries }).status;
      catalogs.push({ sourcePath: selected.sourcePath, sourceSha256: record.objectSha256,
        eventKey: parsed.eventKey, rowCount: parsed.entries.length,
        structuralProjectionStatus: projection, identityDecisions: decisions, fieldDecisions });
    }
    owners.push({ legacyUserId: owner.legacyUserId, proposedPrincipalId: null,
      proposedProfileId: null, oldOwnerAuthenticationEvidenceRef: null,
      newAuthorityEvidenceRef: null, reviewerDecision: "pending", catalogs });
  }
  return { version: 1, status: "private_review_required", approvedForImport: false,
    manifestSha256: manifest.manifestSha256, owners };
}
