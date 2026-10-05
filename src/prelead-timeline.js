import { randomUUID } from "node:crypto";
import { syntheticPreleads } from "./fixtures.js";

const idempotencyId = (profileId, preleadId, key) => `${profileId}\u0000${preleadId}\u0000${key}`;
const sameRequest = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const errorResult = (status, error, operationId) => ({
  status,
  body: operationId ? { error, operationId } : { error }
});

export function normalizePreleadEventRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.type !== "string" ||
      typeof value.operationId !== "string" || !/^op-[0-9a-f-]{36}$/.test(value.operationId)) return null;
  if (value.type === "note_added" && Object.keys(value).every((key) => ["type", "noteText", "operationId"].includes(key)) &&
      typeof value.noteText === "string" && value.noteText.trim().length > 0 && [...value.noteText.trim()].length <= 1000) {
    return { type: "note_added", noteText: value.noteText.trim(), operationId: value.operationId };
  }
  if (value.type === "rejection_added" && Object.keys(value).every((key) => ["type", "reason", "operationId"].includes(key)) &&
      typeof value.reason === "string" && value.reason.trim().length > 0 && [...value.reason.trim()].length <= 300) {
    return { type: "rejection_added", reason: value.reason.trim(), operationId: value.operationId };
  }
  if (value.type === "rejection_undone" && Object.keys(value).every((key) => ["type", "targetEventId", "operationId"].includes(key)) &&
      typeof value.targetEventId === "string" && /^evt-[0-9a-f-]{36}$/.test(value.targetEventId)) {
    return { type: "rejection_undone", targetEventId: value.targetEventId, operationId: value.operationId };
  }
  return null;
}

export function createPreleadTimelineService({ preleads = syntheticPreleads } = {}) {
  const records = new Map(preleads.map((prelead) => [prelead.id, { ...prelead, events: [] }]));
  const idempotency = new Map();

  function findOwned(profileId, preleadId) {
    const prelead = records.get(preleadId);
    return prelead?.profileId === profileId ? prelead : null;
  }

  function latestDispositionEvent(prelead) {
    return [...prelead.events].reverse().find((event) => event.type === "rejection_added" || event.type === "rejection_undone") ?? null;
  }

  function activeRejection(prelead) {
    const latest = latestDispositionEvent(prelead);
    return latest?.type === "rejection_added" ? latest : null;
  }

  function publicPrelead(prelead) {
    return {
      id: prelead.id,
      companyId: prelead.companyId,
      exhibitionId: prelead.exhibitionId,
      stage: prelead.stage,
      disposition: activeRejection(prelead) ? "rejected" : "active"
    };
  }

  function getTimeline({ profileId, preleadId }) {
    const prelead = findOwned(profileId, preleadId);
    if (!prelead) return { status: 404, body: { error: "prelead_not_found" } };
    return {
      status: 200,
      body: { domainApiVersion: "1.0.0", prelead: publicPrelead(prelead), events: prelead.events.map((event) => ({ ...event })) }
    };
  }

  function appendEvent({ profileId, preleadId, request }) {
    const { operationId } = request;
    const prelead = findOwned(profileId, preleadId);
    if (!prelead) return errorResult(404, "prelead_not_found", operationId);
    const key = idempotencyId(profileId, preleadId, operationId);
    const previous = idempotency.get(key);
    if (previous) {
      if (!sameRequest(previous.request, request)) return errorResult(409, "idempotency_conflict", operationId);
      return { status: 200, body: { ...previous.response, replayed: true } };
    }

    if (request.type === "rejection_added" && activeRejection(prelead)) {
      return errorResult(409, "prelead_already_rejected", operationId);
    }
    if (request.type === "rejection_undone") {
      const rejection = activeRejection(prelead);
      if (!rejection || rejection.eventId !== request.targetEventId) {
        return errorResult(409, "undo_not_applicable", operationId);
      }
    }

    const event = {
      eventId: `evt-${randomUUID()}`,
      operationId,
      sequence: prelead.events.length + 1,
      type: request.type,
      payload: request.type === "note_added"
        ? { noteText: request.noteText }
        : request.type === "rejection_added"
          ? { reason: request.reason }
          : { targetEventId: request.targetEventId },
      occurredAt: new Date().toISOString()
    };
    prelead.events.push(event);
    const response = {
      domainApiVersion: "1.0.0",
      prelead: publicPrelead(prelead),
      event: { ...event },
      operationId,
      eventCount: prelead.events.length,
      replayed: false
    };
    idempotency.set(key, { request: { ...request }, response });
    return { status: 201, body: response };
  }

  return { getTimeline, appendEvent };
}
