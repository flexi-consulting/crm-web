// Profile-free publication surface. It accepts only reviewed, immutable fact snapshots.
const EVENT = /^[a-z0-9][a-z0-9-]{0,79}$/;
const SHA = /^[a-f0-9]{64}$/;
const NAME = /^[^\x00-\x1f<>]{1,240}$/;
const STAND = /^[^\x00-\x1f<>]{0,80}$/;
const PUBLIC_FIELDS = ["id", "name", "stand"];
const SNAPSHOT_FIELDS = ["eventKey", "eventTitle", "participants", "projectionSha256", "sourceSha256"];
const ownFields = (value, expected) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...expected].sort().join(",");
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: {
  "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=60",
  "x-content-type-options": "nosniff" } });
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (char) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
function validSnapshot(snapshot) {
  if (!ownFields(snapshot, SNAPSHOT_FIELDS) || !EVENT.test(snapshot.eventKey) ||
      !NAME.test(snapshot.eventTitle) || !SHA.test(snapshot.projectionSha256) ||
      !SHA.test(snapshot.sourceSha256) || !Array.isArray(snapshot.participants) ||
      snapshot.participants.length < 1 || snapshot.participants.length > 20_000) return false;
  const ids = new Set();
  for (const item of snapshot.participants) {
    if (!ownFields(item, PUBLIC_FIELDS) || typeof item.id !== "string" || !/^[a-f0-9]{24}$/.test(item.id) ||
        ids.has(item.id) || typeof item.name !== "string" || !NAME.test(item.name) ||
        typeof item.stand !== "string" || !STAND.test(item.stand) ||
        /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(item.name) || /\+?\d[\d() -]{9,}/.test(item.name)) return false;
    ids.add(item.id);
  }
  return true;
}

export async function createPublicExhibitionReadHandler({ enabled = false, snapshots = [],
  approvedProjectionShas = {} } = {}) {
  if (!enabled) return async () => json(404, { error: "not_found" });
  if (!Array.isArray(snapshots) || !snapshots.every(validSnapshot) ||
      new Set(snapshots.map((item) => item.eventKey)).size !== snapshots.length)
    throw new TypeError("approved_public_snapshots_required");
  for (const snapshot of snapshots) {
    const { projectionSha256, ...core } = snapshot;
    const bytes = new TextEncoder().encode(JSON.stringify(core));
    const actual = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (actual !== projectionSha256 || approvedProjectionShas[snapshot.eventKey] !== actual)
      throw new TypeError("public_projection_receipt_mismatch");
  }
  const byEvent = new Map(snapshots.map((item) => [item.eventKey, structuredClone(item)]));
  return async (request) => {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.searchParams.size) return json(404, { error: "not_found" });
    if (url.pathname === "/public/exhibitions") return json(200, { items: [...byEvent.values()]
      .map(({ eventKey, eventTitle, participants }) => ({ eventKey, eventTitle, count: participants.length })) });
    const match = url.pathname.match(/^\/(public\/)?exhibitions\/([a-z0-9-]{1,80})(\/participants)?$/);
    if (!match) return json(404, { error: "not_found" });
    const snapshot = byEvent.get(match[2]);
    if (!snapshot) return json(404, { error: "exhibition_not_found" });
    if (match[1]) return json(200, { eventKey: snapshot.eventKey,
      eventTitle: snapshot.eventTitle, participants: snapshot.participants });
    if (match[3]) return json(404, { error: "not_found" });
    const cards = snapshot.participants.map((item) => `<li><strong>${escapeHtml(item.name)}</strong>` +
      (item.stand ? ` <span>Стенд ${escapeHtml(item.stand)}</span>` : "") + "</li>").join("");
    const html = `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" ` +
      `content="width=device-width,initial-scale=1"><title>${escapeHtml(snapshot.eventTitle)}</title>` +
      `<main><h1>${escapeHtml(snapshot.eventTitle)}</h1><p>Участников: ${snapshot.participants.length}</p>` +
      `<ul>${cards}</ul></main></html>`;
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=60", "content-security-policy": "default-src 'none'; style-src 'none'; base-uri 'none'; form-action 'none'",
      "x-content-type-options": "nosniff" } });
  };
}

export { validSnapshot };
