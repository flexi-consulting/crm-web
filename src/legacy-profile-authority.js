import { createHash } from "node:crypto";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const hashOk = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const idOk = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const pathOk = (value) => typeof value === "string" && !value.startsWith("/") &&
  !value.includes("\\") && value.split("/").every((part) => part && part !== "." && part !== "..");

// This only checks a proposed migration decision. Neither a directory name nor a
// catalog row is an authentication claim. A live app must still resolve its
// principal/profile through the platform's trusted identity adapter.
export function auditLegacyProfileAuthority({ manifest, authority, mapping, notes }) {
  if (manifest?.version !== 1 || !Array.isArray(manifest.records) ||
      authority?.schemaVersion !== 1 || !Array.isArray(authority.principals) ||
      mapping?.version !== 1 || !hashOk(mapping.authoritySha256) ||
      !Array.isArray(mapping.bindings) || !Array.isArray(notes?.candidates) ||
      !Array.isArray(notes?.quarantine)) throw new Error("legacy_profile_audit_input_invalid");

  const principals = new Map(), keyOwners = new Map();
  for (const principal of authority.principals) {
    if (!idOk(principal.principalId) || !idOk(principal.profileId) ||
        !hashOk(principal.keyHash)) throw new Error("legacy_profile_authority_invalid");
    const previous = principals.get(principal.principalId);
    if (previous && previous !== principal.profileId) throw new Error("legacy_profile_authority_conflict");
    const keyOwner = keyOwners.get(principal.keyHash);
    if (keyOwner && keyOwner !== principal.principalId) throw new Error("legacy_profile_authority_conflict");
    principals.set(principal.principalId, principal.profileId);
    keyOwners.set(principal.keyHash, principal.principalId);
  }
  if (principals.size === 0) throw new Error("legacy_profile_authority_empty");

  const catalogs = manifest.records.filter((record) => record.kind === "deployed_html");
  const bySource = new Map(), ownerNamespaces = new Set();
  for (const record of catalogs) {
    if (!pathOk(record.sourcePath) || !hashOk(record.objectSha256) ||
        !idOk(record.eventKey)) throw new Error("legacy_profile_catalog_invalid");
    if (bySource.has(record.sourcePath)) throw new Error("legacy_profile_catalog_duplicate");
    bySource.set(record.sourcePath, record);
    ownerNamespaces.add(record.sourcePath.split("/")[0]);
  }

  const bindings = new Map(), profileOwners = new Map();
  for (const binding of mapping.bindings) {
    if (!idOk(binding.legacyUserId) || !idOk(binding.principalId) ||
        !idOk(binding.profileId) || !hashOk(binding.evidenceSha256) ||
        typeof binding.evidenceRef !== "string" || binding.evidenceRef.length < 3 ||
        binding.evidenceRef.length > 200) throw new Error("legacy_profile_binding_invalid");
    if (bindings.has(binding.legacyUserId)) throw new Error("legacy_profile_binding_duplicate");
    if (profileOwners.has(binding.profileId) && profileOwners.get(binding.profileId) !== binding.legacyUserId)
      throw new Error("legacy_profile_binding_many_to_one");
    bindings.set(binding.legacyUserId, binding);
    profileOwners.set(binding.profileId, binding.legacyUserId);
  }

  const catalogStatus = new Map();
  for (const record of catalogs) {
    const oldOwner = record.sourcePath.split("/")[0];
    const binding = bindings.get(oldOwner);
    const status = !binding ? "owner_binding_missing" :
      principals.get(binding.principalId) !== binding.profileId ? "authority_mismatch" :
      "binding_candidate_consistent";
    catalogStatus.set(record.sourcePath, status);
  }
  const totals = { catalogs: catalogs.length, catalogBindingCandidates: 0,
    catalogOwnerBindingMissing: 0, catalogAuthorityMismatch: 0,
    noteCandidates: notes.candidates.length, noteBindingCandidates: 0,
    noteQuarantined: notes.quarantine.length, noteSourceMismatch: 0,
    noteOwnerBindingMissing: 0, noteAuthorityMismatch: 0,
    unusedBindings: [...bindings.keys()].filter((oldOwner) => !ownerNamespaces.has(oldOwner)).length };
  for (const status of catalogStatus.values()) {
    if (status === "binding_candidate_consistent") totals.catalogBindingCandidates++;
    if (status === "owner_binding_missing") totals.catalogOwnerBindingMissing++;
    if (status === "authority_mismatch") totals.catalogAuthorityMismatch++;
  }
  const seenPreleads = new Set();
  for (const note of notes.candidates) {
    if (!idOk(note.preleadId) || seenPreleads.has(note.preleadId))
      throw new Error("legacy_profile_note_duplicate");
    seenPreleads.add(note.preleadId);
    const record = bySource.get(note.sourcePath);
    const oldOwner = record?.sourcePath.split("/")[0];
    const binding = bindings.get(oldOwner);
    if (!record || record.objectSha256 !== note.sourceSha256 ||
        record.eventKey !== note.eventKey || note.oldOwnerNamespace !== oldOwner) {
      totals.noteSourceMismatch++; continue;
    }
    if (!binding) { totals.noteOwnerBindingMissing++; continue; }
    if (principals.get(binding.principalId) !== binding.profileId ||
        note.trustedProfileRef !== binding.profileId) {
      totals.noteAuthorityMismatch++; continue;
    }
    // Row resolution, note semantics and reviewer consent are separate gates.
    totals.noteBindingCandidates++;
  }
  for (const note of notes.quarantine) {
    if (!idOk(note.preleadId) || seenPreleads.has(note.preleadId))
      throw new Error("legacy_profile_note_duplicate");
    seenPreleads.add(note.preleadId);
  }
  return { version: 1, status: "offline_identity_audit_only", totals,
    sourceReceipt: { manifestSha256: mapping.manifestSha256,
      authoritySha256: mapping.authoritySha256,
      notesSha256: mapping.notesSha256 },
    // These counts never grant write permission or automatically link a note.
    approvedForImport: false,
    mappingFingerprint: sha(JSON.stringify(mapping.bindings.map(({ legacyUserId, profileId, principalId }) =>
      [legacyUserId, profileId, principalId]).sort())) };
}
