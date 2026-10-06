import { createHash } from "node:crypto";
import { catalog } from "./fixtures.js";
import { validateReport } from "./catalog-build.js";
import { CATALOG_BUILD_SCHEMA_VERSION } from "./catalog-version.js";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const preleadId = (profileRef, eventId, companyId) => `built-prelead-${sha(JSON.stringify([profileRef, eventId, companyId])).slice(0, 24)}`;
const changed = (result) => Number(result?.meta?.changes ?? 0) === 1;
const validBuild = (build) => build?.buildId && /^build-[a-f0-9]{24}$/.test(build.buildId) &&
  build.artifact?.schemaVersion === CATALOG_BUILD_SCHEMA_VERSION && /^[a-z0-9][a-z0-9-]{0,79}$/.test(build.artifact.exhibitionId) &&
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

  async function getBuildByKey({ profileRef, idempotencyKey }) {
    const row = await db.prepare("SELECT build_id FROM s02_catalog_builds WHERE profile_ref = ? AND idempotency_key = ?")
      .bind(profileRef, idempotencyKey).first();
    return row ? getBuild({ profileRef, buildId: row.build_id }) : null;
  }

  async function saveBuild({ profileRef, idempotencyKey, build, legacyRefs = [] }) {
    let accepted = false;
    try { accepted = validBuild(build); } catch {}
    if (!accepted || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(profileRef) ||
        typeof idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey))
      return { status: "invalid_build" };
    if (!Array.isArray(legacyRefs) || legacyRefs.length > build.artifact.companies.length ||
        legacyRefs.length > 0 && legacyRefs.length !== build.artifact.companies.length ||
        new Set(legacyRefs.map((ref) => ref.legacyId)).size !== legacyRefs.length ||
        new Set(legacyRefs.map((ref) => ref.companyId)).size !== legacyRefs.length ||
        legacyRefs.some((ref) => !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(ref?.legacyId ?? "") ||
          ref.companyId !== `co-${sha(JSON.stringify([build.artifact.exhibitionId, ref.legacyId])).slice(0, 20)}` ||
          !build.artifact.companies.some((item) => item.id === ref.companyId)))
      return { status: "invalid_legacy_refs" };
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
    for (const ref of legacyRefs) statements.push(db.prepare(`INSERT INTO s02_legacy_participant_refs
      (profile_ref, event_key, legacy_company_id, build_id, company_id)
      VALUES (?, ?, ?, ?, ?)`)
      .bind(profileRef, build.artifact.exhibitionId, ref.legacyId, build.buildId, ref.companyId));
    try { await db.batch(statements); return { status: "stored", buildId: build.buildId }; }
    catch {
      const prior = await db.prepare("SELECT build_id, content_sha FROM s02_catalog_builds WHERE profile_ref = ? AND idempotency_key = ?")
        .bind(profileRef, idempotencyKey).first();
      if (!prior) return { status: "storage_unavailable" };
      if (prior.build_id !== build.buildId || prior.content_sha !== contentSha) return { status: "build_conflict" };
      try {
        const refs = await db.prepare(`SELECT legacy_company_id, company_id FROM s02_legacy_participant_refs
          WHERE profile_ref = ? AND event_key = ? AND build_id = ? ORDER BY legacy_company_id`)
          .bind(profileRef, build.artifact.exhibitionId, build.buildId).all();
        const expected = legacyRefs.map((ref) => [ref.legacyId, ref.companyId]).sort((a, b) => a[0].localeCompare(b[0]));
        const actual = (refs.results ?? []).map((ref) => [ref.legacy_company_id, ref.company_id]);
        return JSON.stringify(actual) === JSON.stringify(expected)
          ? { status: "replay", buildId: prior.build_id } : { status: "build_conflict" };
      } catch { return { status: "storage_unavailable" }; }
    }
  }

  async function resolveLegacyParticipant({ profileRef, eventKey, legacyId, sourceRevision = null }) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(profileRef ?? "") ||
        !/^[a-z0-9][a-z0-9-]{0,79}$/.test(eventKey ?? "") ||
        !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(legacyId ?? "") ||
        sourceRevision !== null && !/^legacy-ex-sha256-[a-f0-9]{64}$/.test(sourceRevision))
      return { status: 400, body: { error: "invalid_legacy_link" } };
    const latest = await db.prepare(`SELECT b.build_id, b.source_revision FROM s02_catalog_builds b
      WHERE b.profile_ref = ? AND b.event_id = ? AND EXISTS
      (SELECT 1 FROM s02_legacy_participant_refs r WHERE r.build_id = b.build_id)
      ORDER BY b.created_at DESC, b.rowid DESC LIMIT 1`).bind(profileRef, eventKey).first();
    if (!latest) return { status: 404, body: { error: "legacy_link_not_found" } };
    if (sourceRevision !== null && latest.source_revision !== sourceRevision)
      return { status: 409, body: { error: "legacy_link_revision_changed" } };
    const rows = await db.prepare(`SELECT r.company_id, r.build_id, b.source_revision
      FROM s02_legacy_participant_refs r JOIN s02_catalog_builds b ON b.build_id = r.build_id
      WHERE r.profile_ref = ? AND r.event_key = ? AND r.legacy_company_id = ?
      ORDER BY b.created_at DESC, b.rowid DESC`).bind(profileRef, eventKey, legacyId).all();
    const refs = rows.results ?? [];
    if (!refs.length) return { status: 404, body: { error: "legacy_link_not_found" } };
    if (new Set(refs.map((ref) => ref.company_id)).size !== 1)
      return { status: 409, body: { error: "legacy_link_ambiguous" } };
    const selected = refs.find((ref) => ref.build_id === latest.build_id);
    if (!selected) return { status: 404, body: { error: "legacy_link_not_found" } };
    return { status: 200, body: { exhibitionId: eventKey, legacyId, companyId: selected.company_id,
      buildId: selected.build_id, sourceRevision: selected.source_revision,
      detailPath: `/api/v1/catalog-builds/${selected.build_id}/participants/${selected.company_id}` } };
  }

  async function readParticipants({ profileRef, buildId, companyId = null, query = "", classification = null }) {
    if (!/^build-[a-f0-9]{24}$/.test(buildId ?? "") ||
        (companyId !== null && !/^co-[a-f0-9]{20}$/.test(companyId)) ||
        typeof query !== "string" || [...query].length > 120 ||
        (classification !== null && !["target", "near_target", "not_target", "unknown"].includes(classification)))
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
      const refs = await db.prepare("SELECT build_id FROM s02_prelead_build_refs WHERE prelead_id = ? ORDER BY rowid")
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

  async function appendDisposition({ profileRef, preleadId: id, request }) {
    if (!/^built-prelead-[a-f0-9]{24}$/.test(id) || !/^op-[0-9a-f-]{36}$/.test(request?.operationId ?? "") ||
        !["rejection_added", "rejection_undone"].includes(request?.type))
      return { status: 400, body: { error: "invalid_disposition" } };
    const rejection = request.type === "rejection_added";
    if (rejection ? typeof request.reason !== "string" || !request.reason.trim() ||
        [...request.reason.trim()].length > 300 : !/^evt-[0-9a-f-]{36}$/.test(request.targetEventId ?? ""))
      return { status: 400, body: { error: "invalid_disposition" } };
    const payload = rejection ? { reason: request.reason.trim() } : { targetEventId: request.targetEventId };
    const payloadJson = JSON.stringify(payload);
    const eventId = `evt-${sha(JSON.stringify([id, request.operationId])).slice(0, 36)}`;
    const latest = `(SELECT kind FROM s04_prelead_events e WHERE e.prelead_id = p.prelead_id
      AND e.kind IN ('rejection_added','rejection_undone') ORDER BY e.sequence DESC LIMIT 1)`;
    const condition = rejection ? `COALESCE(${latest}, '') <> 'rejection_added'` :
      `EXISTS (SELECT 1 FROM s04_prelead_events e WHERE e.prelead_id = p.prelead_id
        AND e.event_id = ? AND e.kind = 'rejection_added' AND e.sequence =
        (SELECT MAX(sequence) FROM s04_prelead_events WHERE prelead_id = p.prelead_id
          AND kind IN ('rejection_added','rejection_undone')))`;
    try {
      const [insert] = await db.batch([
        db.prepare(`INSERT INTO s04_prelead_events
          (event_id, prelead_id, profile_ref, operation_id, sequence, kind, payload_json, created_at)
          SELECT ?, p.prelead_id, p.profile_ref, ?, p.revision + 1, ?, ?, ?
          FROM s04_preleads p WHERE p.prelead_id = ? AND p.profile_ref = ?
          AND NOT EXISTS (SELECT 1 FROM s04_prelead_events d WHERE d.prelead_id = p.prelead_id AND d.kind = 'deal_linked')
          AND NOT EXISTS (SELECT 1 FROM s04_deal_operations o WHERE o.prelead_id = p.prelead_id
            AND o.status IN ('unknown','created'))
          AND ${condition}`)
          .bind(eventId, request.operationId, request.type, payloadJson, now(), id, profileRef,
            ...(rejection ? [] : [request.targetEventId])),
        db.prepare(`UPDATE s04_preleads SET revision = revision + 1
          WHERE prelead_id = ? AND profile_ref = ? AND EXISTS
          (SELECT 1 FROM s04_prelead_events WHERE event_id = ? AND prelead_id = ?)`)
          .bind(id, profileRef, eventId, id)
      ]);
      if (changed(insert)) return { status: 201, body: { eventId, operationId: request.operationId,
        type: request.type, payload, replayed: false } };
    } catch {}
    const existing = await db.prepare(`SELECT event_id, kind, payload_json FROM s04_prelead_events
      WHERE prelead_id = ? AND profile_ref = ? AND operation_id = ?`)
      .bind(id, profileRef, request.operationId).first();
    if (existing) return existing.kind === request.type && existing.payload_json === payloadJson
      ? { status: 200, body: { eventId: existing.event_id, operationId: request.operationId,
        type: request.type, payload, replayed: true } }
      : { status: 409, body: { error: "idempotency_conflict" } };
    const prelead = await db.prepare("SELECT prelead_id FROM s04_preleads WHERE prelead_id = ? AND profile_ref = ?")
      .bind(id, profileRef).first();
    if (!prelead) return { status: 404, body: { error: "prelead_not_found" } };
    const deal = await db.prepare("SELECT event_id FROM s04_prelead_events WHERE prelead_id = ? AND kind = 'deal_linked'")
      .bind(id).first();
    const operation = await db.prepare(`SELECT operation_id FROM s04_deal_operations
      WHERE prelead_id = ? AND status IN ('unknown','created') LIMIT 1`).bind(id).first();
    if (deal || operation) return { status: 409, body: { error: "prelead_deal_conflict" } };
    return { status: 409, body: { error: rejection ? "prelead_already_rejected" : "undo_not_applicable" } };
  }

  async function getTimeline({ profileRef, preleadId: id }) {
    const prelead = await db.prepare(`SELECT prelead_id, event_id, company_id, revision FROM s04_preleads
      WHERE prelead_id = ? AND profile_ref = ?`).bind(id, profileRef).first();
    if (!prelead) return { status: 404, body: { error: "prelead_not_found" } };
    const refs = await db.prepare("SELECT build_id FROM s02_prelead_build_refs WHERE prelead_id = ? ORDER BY rowid")
      .bind(id).all();
    const sourceBuildIds = (refs.results ?? []).map((row) => row.build_id);
    if (sourceBuildIds.length === 0) return { status: 404, body: { error: "prelead_not_found" } };
    const rows = await db.prepare(`SELECT event_id, operation_id, sequence, kind, payload_json, created_at
      FROM s04_prelead_events WHERE prelead_id = ? AND profile_ref = ? ORDER BY sequence`)
      .bind(id, profileRef).all();
    let events;
    try { events = (rows.results ?? []).map((row) => ({
      eventId: row.kind === "deal_linked" ? `evt-${sha(row.event_id).slice(0, 36)}` : row.event_id,
      operationId: row.operation_id, sequence: row.sequence, type: row.kind,
      payload: JSON.parse(row.payload_json), occurredAt: row.created_at
    })); } catch { return { status: 503, body: { error: "prelead_event_invalid" } }; }
    const kinds = events.map((event) => event.type);
    const disposition = kinds.includes("deal_linked") ? "deal"
      : [...kinds].reverse().find((kind) => kind === "rejection_added" || kind === "rejection_undone") === "rejection_added"
        ? "rejected" : "active";
    return { status: 200, body: { domainApiVersion: "1.0.0", prelead: {
      id, companyId: prelead.company_id, exhibitionId: prelead.event_id,
      buildId: sourceBuildIds.at(-1), sourceBuildIds, stage: "draft", disposition
    }, events } };
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

  return { saveBuild, getBuild, getBuildByKey, resolveLegacyParticipant, readParticipants, ensurePrelead,
    appendNote, appendDisposition, getTimeline, resolve };
}
