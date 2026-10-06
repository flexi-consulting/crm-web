const shaOk = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const idOk = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const pathOk = (value) => typeof value === "string" && !value.startsWith("/") &&
  !value.includes("\\") && value.split("/").every((part) => part && part !== "." && part !== "..");

// Build a private reviewer queue from a frozen catalog manifest. This does not
// infer a new profile from a legacy owner namespace or approve an import.
export function buildLegacyProfileReviewPacket(manifest, manifestSha256) {
  if (!shaOk(manifestSha256) || manifest?.version !== 1 || !Array.isArray(manifest.records))
    throw new Error("review_packet_manifest_invalid");
  const owners = new Map(), paths = new Set();
  for (const record of manifest.records) {
    if (record?.kind !== "deployed_html") continue;
    if (!pathOk(record.sourcePath) || !idOk(record.eventKey) || !shaOk(record.objectSha256) ||
        paths.has(record.sourcePath)) throw new Error("review_packet_catalog_invalid");
    paths.add(record.sourcePath);
    const legacyUserId = record.sourcePath.split("/")[0];
    if (!idOk(legacyUserId)) throw new Error("review_packet_owner_invalid");
    const catalogs = owners.get(legacyUserId) ?? [];
    catalogs.push({ sourcePath: record.sourcePath, eventKey: record.eventKey,
      objectSha256: record.objectSha256 });
    owners.set(legacyUserId, catalogs);
  }
  if (paths.size === 0) throw new Error("review_packet_catalog_empty");
  return { version: 1, status: "manual_review_required", manifestSha256,
    approvedForImport: false, owners: [...owners.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([legacyUserId, catalogs]) => ({ legacyUserId,
        catalogs: catalogs.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath)),
        proposedPrincipalId: null, proposedProfileId: null,
        oldOwnerAuthenticationEvidenceRef: null, newAuthorityEvidenceRef: null,
        reviewerDecision: "pending" })) };
}
