import { createHash } from "node:crypto";
import { projectLegacyExSnapshot } from "./legacy-ex-snapshot.js";
import { parseLegacyExHtml } from "./legacy-ex-html.js";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const shaOk = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const idOk = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);

function decisionMap(decisions, rowCount, expectedKeys, name) {
  if (!Array.isArray(decisions) || decisions.length !== rowCount) throw new Error(`${name}_coverage_invalid`);
  const seen = new Set();
  for (const decision of decisions) {
    if (!decision || !Number.isSafeInteger(decision.index) || decision.index < 0 || decision.index >= rowCount || seen.has(decision.index))
      throw new Error(`${name}_coverage_invalid`);
    if (!shaOk(decision.rowSha256) || decision.rowSha256 !== expectedKeys.get(decision.index))
      throw new Error(`${name}_row_binding_invalid`);
    seen.add(decision.index);
  }
  if (seen.size !== rowCount) throw new Error(`${name}_coverage_invalid`);
  return new Map(decisions.map((decision) => [decision.index, decision]));
}

// Validates an explicit offline review against a separately verified backup
// and owner packet. This function only projects; it never persists or imports.
export function prepareApprovedLegacyImport({ packet, manifestSha256, sourceSha256,
  sourcePath, eventKey, profileBinding, sourceBytes, decisions }) {
  if (!packet || packet.version !== 1 || packet.approvedForImport !== false ||
      packet.status !== "private_review_required" || !shaOk(manifestSha256) ||
      packet.manifestSha256 !== manifestSha256 || !shaOk(sourceSha256) ||
      !Array.isArray(packet.owners) || !(sourceBytes instanceof Uint8Array))
    return { status: "review_packet_invalid" };
  const bytes = Buffer.from(sourceBytes);
  if (sha(bytes) !== sourceSha256) return { status: "source_bytes_mismatch" };
  let parsed;
  try { parsed = parseLegacyExHtml(bytes); } catch { return { status: "source_html_invalid" }; }
  if (parsed.eventKey !== eventKey) return { status: "source_event_mismatch" };
  const entries = parsed.entries;
  const owner = packet.owners.find((candidate) => candidate.catalogs?.some((catalog) =>
    catalog.sourcePath === sourcePath && catalog.sourceSha256 === sourceSha256 && catalog.eventKey === eventKey));
  if (!owner) return { status: "source_not_in_review_packet" };
  if (!profileBinding || profileBinding.status !== "confirmed" || profileBinding.issuer !== "control-plane" ||
      !idOk(profileBinding.principalId) || !idOk(profileBinding.profileId) ||
      !shaOk(profileBinding.evidenceSha256) || profileBinding.legacyUserId !== owner.legacyUserId)
    return { status: "profile_binding_unverified" };
  if (!decisions || decisions.version !== 1 || decisions.status !== "reviewed" ||
      decisions.packetSha256 !== sha(JSON.stringify(packet)) || decisions.manifestSha256 !== manifestSha256 ||
      decisions.sourcePath !== sourcePath || decisions.sourceSha256 !== sourceSha256 ||
      decisions.eventKey !== eventKey || decisions.legacyUserId !== owner.legacyUserId ||
      decisions.profileBindingEvidenceSha256 !== profileBinding.evidenceSha256 ||
      decisions.profileId !== profileBinding.profileId || decisions.principalId !== profileBinding.principalId ||
      !shaOk(decisions.reviewerEvidenceSha256) || !shaOk(decisions.packetSha256))
    return { status: "review_decisions_unverified" };
  const rowHashes = new Map(entries.map((row, index) => [index, sha(JSON.stringify(row))]));
  let byIndex;
  try { byIndex = decisionMap(decisions.rows, entries.length, rowHashes, "row_decision"); }
  catch (error) { return { status: error.message }; }
  const accepted = [];
  const excluded = [];
  for (const [index, row] of entries.entries()) {
    const decision = byIndex.get(index);
    if (decision.outcome === "include" && shaOk(decision.evidenceSha256) &&
        decision.replacement && typeof decision.replacement === "object" && !Array.isArray(decision.replacement))
      accepted.push(decision.replacement);
    else if (decision.outcome === "exclude" && typeof decision.reason === "string" && decision.reason.trim() && shaOk(decision.evidenceSha256)) excluded.push(index);
    else return { status: "row_decision_invalid" };
  }
  if (accepted.length === 0) return { status: "no_approved_rows" };
  const projection = projectLegacyExSnapshot({ profileRef: profileBinding.profileId, eventKey, entries: accepted });
  if (projection.status !== "projected") return { status: projection.status };
  return { status: "reviewed_projection_ready", manifestSha256, sourceSha256, sourcePath,
    legacyUserId: owner.legacyUserId, profileId: profileBinding.profileId,
    profileEvidenceSha256: profileBinding.evidenceSha256,
    reviewerEvidenceSha256: decisions.reviewerEvidenceSha256,
    includedRows: accepted.length, excludedSourceIndexes: excluded,
    idempotencyKey: projection.idempotencyKey, build: projection.build, legacyRefs: projection.legacyRefs };
}

// Persistence boundary for the app-owned catalog repository. Callers must
// provide the separately verified owner/profile and reviewer receipts above.
export async function importReviewedLegacyExSnapshot({ repository, ...review }) {
  if (!repository?.saveBuild) return { status: "catalog_repository_required" };
  const prepared = prepareApprovedLegacyImport(review);
  if (prepared.status !== "reviewed_projection_ready") return prepared;
  let saved;
  try {
    saved = await repository.saveBuild({ profileRef: prepared.profileId,
      idempotencyKey: prepared.idempotencyKey, build: prepared.build,
      legacyRefs: prepared.legacyRefs });
  } catch { return { status: "catalog_storage_unavailable" }; }
  if (saved?.status !== "stored" && saved?.status !== "replay") {
    if (saved?.status === "storage_unavailable") return { status: "catalog_storage_unavailable" };
    if (saved?.status === "invalid_build") return { status: "catalog_projection_invalid" };
    if (saved?.status === "invalid_legacy_refs") return { status: "legacy_reference_conflict" };
    return { status: "catalog_import_conflict" };
  }
  return { status: saved.status, buildId: saved.buildId, sourceRevision: prepared.build.artifact.sourceRevision,
    imported: prepared.includedRows, excluded: prepared.excludedSourceIndexes.length };
}
