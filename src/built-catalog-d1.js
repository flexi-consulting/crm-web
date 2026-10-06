import { createHash } from "node:crypto";
import { catalog } from "./fixtures.js";
import { validateReport } from "./catalog-build.js";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const preleadId = (profileRef, eventId, companyId) => `built-prelead-${sha(JSON.stringify([profileRef, eventId, companyId])).slice(0, 24)}`;
const changed = (result) => Number(result?.meta?.changes ?? 0) === 1;
const validBuild = (build) => build?.buildId && /^build-[a-f0-9]{24}$/.test(build.buildId) &&
  build.artifact?.schemaVersion === "1.0.0" && /^demo-expo-[0-9]{3}$/.test(build.artifact.exhibitionId) &&
  typeof build.artifact.sourceRevision === "string" && build.artifact.sourceRevision.length > 0 &&
  Array.isArray(build.artifact.companies) && build.artifact.companies.length <= 20_000 &&
  build.report?.validation?.valid === true && build.report.exhibitionId === build.artifact.exhibitionId &&
  build.report.sourceRevision === build.artifact.sourceRevision &&
  new Set(build.artifact.companies.map((item) => item.id)).size === build.artifact.companies.length &&
  build.artifact.companies.every((item) => /^co-[a-f0-9]{20}$/.test(item.id)) &&
  (() => { const checked = validateReport(build.artifact, build.report);
    return checked.valid && JSON.stringify(checked.counts) === JSON.stringify(build.report.validation.counts) &&
      Array.isArray(build.report.validation.issues) && build.report.validation.issues.length === 0; })();

// Local D1 port for validated synthetic builds, stable participant bindings and note events.
export function createBuiltCatalogD1Repository(db, now = () => new Date().toISOString()) {
  if (!db?.prepare || !db?.batch) throw new Error("d1_binding_required");

  async function getBuild({ profileRef, buildId }) {
    const row = await db.prepare("SELECT * FROM s02_catalog_builds WHERE profile_ref = ? AND build_id = ?")
      .bind(profileRef, buildId).first();
    if (!row) return null;
    try {
      if (sha(JSON.stringify([row.artifact_json, row.report_json])) !== row.content_sha) return null;
      return { buildId: row.build_id, artifact: JSON.parse(row.artifact_json),
        report: JSON.parse(row.report_json), contentSha: row.content_sha };
    } catch { return null; }
  }

  async function saveBuild({ profileRef, idempotencyKey, build }) {
    let accepted = false;
    try { accepted = validBuild(build); } catch {}
    if (!accepted || !/^demo-profile-[a-z]$/.test(profileRef) ||
        typeof idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey))
      return { status: "invalid_build" };
    const artifactJson = JSON.stringify(build.artifact);
    const reportJson = JSON.stringify(build.report);
    const contentSha = sha(JSON.stringify([artifactJson, reportJson]));
    const statements = [db.prepare(`INSERT INTO s02_catalog_builds
      (build_id, profile_ref, idempotency_key, event_id, source_revision, artifact_json, report_json, content_sha, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(build.buildId, profileRef, idempotencyKey, build.artifact.exhibitionId,
        build.artifact.sourceRevision, artifactJson, reportJson, contentSha, now())];
    for (const participant of build.artifact.companies) statements.push(db.prepare(`INSERT INTO s02_catalog_participants
      (build_id, company_id, participant_json) VALUES (?, ?, ?)`)
      .bind(build.buildId, participant.id, JSON.stringify(participant)));
    try { await db.batch(statements); return { status: "stored", buildId: build.buildId }; }
    catch {
      const prior = await db.prepare("SELECT build_id, content_sha FROM s02_catalog_builds WHERE profile_ref = ? AND idempotency_key = ?")
        .bind(profileRef, idempotencyKey).first();
      return !prior ? { status: "storage_unavailable" } : prior.build_id === build.buildId && prior.content_sha === contentSha
        ? { status: "replay", buildId: prior.build_id } : { status: "build_conflict" };
    }
  }

  async function readParticipants({ profileRef, buildId, companyId = null, query = "", classification = null }) {
    if (!/^build-[a-f0-9]{24}$/.test(buildId ?? "") ||
        (companyId !== null && !/^co-[a-f0-9]{20}$/.test(companyId)) ||
        typeof query !== "string" || [...query].length > 120 ||
        (classification !== null && !["target", "near_target", "not_target"].includes(classification)))
      return { status: 400, body: { error: "invalid_query" } };
    const build = await getBuild({ profileRef, buildId });
    if (!build) return { status: 404, body: { error: "catalog_build_not_found" } };
    if (build.report.validation?.valid !== true) return { status: 409, body: { error: "validated_build_required" } };
    const rows = await db.prepare(`SELECT participant_json FROM s02_catalog_participants WHERE build_id = ? ORDER BY company_id`)
      .bind(buildId).all();
    let items;
    try { items = (rows.results ?? []).map((row) => JSON.parse(row.participant_json)); }
    catch { return { status: 503, body: { error: "catalog_artifact_invalid" } }; }
    const expected = new Map(build.artifact.companies.map((item) => [item.id, JSON.stringify(item)]));
    if (items.length !== expected.size || items.some((item) => expected.get(item.id) !== JSON.stringify(item)))
      return { status: 503, body: { error: "catalog_artifact_incomplete" } };
    const q = query.trim().toLocaleLowerCase("en");
    items = items.filter((item) => (companyId === null || item.id === companyId) &&
      (classification === null || item.qualification.classification === classification) &&
      (!q || `${item.name} ${item.source.country} ${item.source.booth ?? ""}`.toLocaleLowerCase("en").includes(q)))
      .map((item) => ({ ...item, detailPath: `/api/v1/catalog-builds/${buildId}/participants/${item.id}` }));
    if (companyId !== null && items.length === 0) return { status: 404, body: { error: "participant_not_found" } };
    return { status: 200, body: { domainApiVersion: "1.0.0", buildId,
      exhibitionId: build.artifact.exhibitionId, sourceRevision: build.artifact.sourceRevision, items } };
  }

  async function ensurePrelead({ profileRef, buildId, companyId }) {
    const selected = await readParticipants({ profileRef, buildId, companyId });
    if (selected.status !== 200) return selected;
    const eventId = selected.body.exhibitionId;
    const id = preleadId(profileRef, eventId, companyId);
    try {
      const [, insertedRef] = await db.batch([
        db.prepare(`INSERT OR IGNORE INTO s04_preleads
          (prelead_id, profile_ref, event_id, company_id, revision, created_at) VALUES (?, ?, ?, ?, 0, ?)`)
          .bind(id, profileRef, eventId, companyId, now()),
        db.prepare(`INSERT OR IGNORE INTO s02_prelead_build_refs
          (prelead_id, build_id, company_id, created_at)
          SELECT p.prelead_id, b.build_id, ?, ? FROM s04_preleads p
          JOIN s02_catalog_builds b ON b.profile_ref = p.profile_ref AND b.event_id = p.event_id
          JOIN s02_catalog_participants c ON c.build_id = b.build_id AND c.company_id = p.company_id
          WHERE p.prelead_id = ? AND p.profile_ref = ? AND p.event_id = ? AND p.company_id = ? AND b.build_id = ?`)
          .bind(companyId, now(), id, profileRef, eventId, companyId, buildId)
      ]);
      const added = changed(insertedRef);
      const binding = await db.prepare(`SELECT p.prelead_id, p.revision FROM s04_preleads p
        JOIN s02_prelead_build_refs r ON r.prelead_id = p.prelead_id
        WHERE p.prelead_id = ? AND p.profile_ref = ? AND r.build_id = ? AND r.company_id = ?`)
        .bind(id, profileRef, buildId, companyId).first();
      if (!binding) return { status: 409, body: { error: "prelead_identity_conflict" } };
      const refs = await db.prepare("SELECT build_id FROM s02_prelead_build_refs WHERE prelead_id = ? ORDER BY created_at, build_id")
        .bind(id).all();
      const events = await db.prepare("SELECT kind FROM s04_prelead_events WHERE prelead_id = ? AND profile_ref = ? ORDER BY sequence")
        .bind(id, profileRef).all();
      const kinds = (events.results ?? []).map((event) => event.kind);
      const disposition = kinds.includes("deal_linked") ? "deal"
        : [...kinds].reverse().find((kind) => kind === "rejection_added" || kind === "rejection_undone") === "rejection_added"
          ? "rejected" : "active";
      return { status: added ? 201 : 200, body: { domainApiVersion: "1.0.0", prelead: {
        id, companyId, exhibitionId: eventId, buildId, sourceBuildIds: (refs.results ?? []).map((row) => row.build_id),
        stage: "draft", disposition }, replayed: !added } };
    } catch { return { status: 503, body: { error: "prelead_storage_unavailable" } }; }
  }

  async function appendNote({ profileRef, preleadId: id, operationId, noteText }) {
    if (!/^built-prelead-[a-f0-9]{24}$/.test(id) || !/^op-[0-9a-f-]{36}$/.test(operationId) ||
        typeof noteText !== "string" || !noteText.trim() || [...noteText.trim()].length > 1000)
      return { status: 400, body: { error: "invalid_note" } };
    const payload = JSON.stringify({ noteText: noteText.trim() });
    const eventId = `evt-${sha(JSON.stringify([id, operationId])).slice(0, 36)}`;
    try {
      const [insert] = await db.batch([
        db.prepare(`INSERT INTO s04_prelead_events
          (event_id, prelead_id, profile_ref, operation_id, sequence, kind, payload_json, created_at)
          SELECT ?, prelead_id, profile_ref, ?, revision + 1, 'note_added', ?, ? FROM s04_preleads
          WHERE prelead_id = ? AND profile_ref = ?`)
          .bind(eventId, operationId, payload, now(), id, profileRef),
        db.prepare(`UPDATE s04_preleads SET revision = revision + 1
          WHERE prelead_id = ? AND profile_ref = ? AND EXISTS
          (SELECT 1 FROM s04_prelead_events WHERE event_id = ? AND prelead_id = ?)`)
          .bind(id, profileRef, eventId, id)
      ]);
      if (changed(insert)) return { status: 201, body: { eventId, operationId, type: "note_added", payload: { noteText: noteText.trim() }, replayed: false } };
    } catch {}
    const existing = await db.prepare(`SELECT kind, payload_json FROM s04_prelead_events
      WHERE prelead_id = ? AND profile_ref = ? AND operation_id = ?`).bind(id, profileRef, operationId).first();
    if (existing) return existing.kind === "note_added" && existing.payload_json === payload
      ? { status: 200, body: { eventId, operationId, type: "note_added", payload: { noteText: noteText.trim() }, replayed: true } }
      : { status: 409, body: { error: "idempotency_conflict" } };
    const owned = await db.prepare("SELECT prelead_id FROM s04_preleads WHERE prelead_id = ? AND profile_ref = ?")
      .bind(id, profileRef).first();
    return { status: owned ? 503 : 404, body: { error: owned ? "prelead_storage_unavailable" : "prelead_not_found" } };
  }

  async function resolve({ profileId, exhibitionId, companyId, buildId }) {
    if (!buildId) return null;
    const selected = await readParticipants({ profileRef: profileId, buildId, companyId });
    if (selected.status !== 200 || selected.body.exhibitionId !== exhibitionId) return null;
    const id = preleadId(profileId, exhibitionId, companyId);
    const bound = await db.prepare(`SELECT r.prelead_id FROM s02_prelead_build_refs r
      JOIN s04_preleads p ON p.prelead_id = r.prelead_id
      WHERE r.prelead_id = ? AND r.build_id = ? AND r.company_id = ?
        AND p.profile_ref = ? AND p.event_id = ? AND p.company_id = ?`)
      .bind(id, buildId, companyId, profileId, exhibitionId, companyId).first();
    const exhibition = catalog.find((item) => item.id === exhibitionId);
    return bound && exhibition ? { company: selected.body.items[0], exhibition, buildId, preleadId: id } : null;
  }

  return { saveBuild, getBuild, readParticipants, ensurePrelead, appendNote, resolve };
}
