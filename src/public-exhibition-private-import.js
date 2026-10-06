import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseLegacyExHtml, verifyLegacyCatalogBackup } from "./private-legacy-handoff.js";
import { validSnapshot } from "./public-exhibition-facts.js";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const HTTPS = (value) => {
  if (typeof value !== "string") return false;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; }
  catch { return false; }
};
const DECLARED_FIELDS = ["eventKey", "eventTitle", "sourcePath", "sourceSha256",
  "publicSourceUrl", "rightsEvidenceUrl", "rightsDecision", "reviewers"];
function validDecision(value) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...DECLARED_FIELDS].sort().join(",") &&
    value.rightsDecision === "publisher_approved_republication" &&
    HTTPS(value.publicSourceUrl) && HTTPS(value.rightsEvidenceUrl) &&
    Array.isArray(value.reviewers) && value.reviewers.length === 2 &&
    value.reviewers.every((item) => typeof item === "string" && /^[A-Za-z0-9._:-]{3,80}$/.test(item)) &&
    value.reviewers[0] !== value.reviewers[1];
}

/** Private, read-only preparation. Never commits captured HTML, decisions or projected facts. */
export async function preparePublicExhibitionSnapshot({ backupDir, decision }) {
  if (!validDecision(decision)) throw new Error("publication_decision_required");
  const manifest = await verifyLegacyCatalogBackup(backupDir);
  const row = manifest.records.find((item) => item.sourcePath === decision.sourcePath &&
    item.kind === "deployed_html" && item.objectSha256 === decision.sourceSha256);
  if (!row) throw new Error("public_source_receipt_mismatch");
  const bytes = await readFile(join(resolve(backupDir), "objects", row.objectSha256));
  if (sha(bytes) !== decision.sourceSha256) throw new Error("public_source_receipt_mismatch");
  const source = parseLegacyExHtml(bytes);
  if (source.eventKey !== decision.eventKey) throw new Error("public_event_mismatch");
  if (!Array.isArray(source.entries) || source.entries.length < 1 || source.entries.length > 20_000)
    throw new Error("public_source_rows_invalid");
  const participants = source.entries.map((entry, index) => {
    const name = typeof entry?.n === "string" ? entry.n.trim().replace(/\s+/g, " ") : "";
    const stand = typeof entry?.s === "string" ? entry.s.trim().replace(/\s+/g, " ") : "";
    return { id: sha(JSON.stringify([source.eventKey, row.objectSha256, index])).slice(0, 24), name, stand };
  });
  const core = { eventKey: source.eventKey, eventTitle: decision.eventTitle,
    sourceSha256: row.objectSha256, participants };
  const snapshot = { ...core, projectionSha256: sha(JSON.stringify(core)) };
  if (!validSnapshot(snapshot)) throw new Error("public_projection_invalid");
  return { snapshot, receipt: { sourceSha256: row.objectSha256,
    manifestSha256: manifest.manifestSha256, projectionSha256: snapshot.projectionSha256,
    publicSourceUrl: decision.publicSourceUrl, rightsEvidenceUrl: decision.rightsEvidenceUrl,
    reviewers: [...decision.reviewers] } };
}
