import test from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFile } from "node:fs/promises";
import { createServer } from "../src/server.js";

const scopes = ["crm.companies.read", "crm.preleads.read", "crm.preleads.events.append"];
const profileHeaders = (profileId, grantedScopes = scopes) => ({
  "x-test-profile": profileId,
  "x-test-scopes": grantedScopes.join(" ")
});
const operationId = (n) => `op-00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const timelinePath = (preleadId) => `/api/v1/preleads/${preleadId}/timeline`;
const eventsPath = (preleadId) => `/api/v1/preleads/${preleadId}/events`;

async function withServer(run, { trusted = true } = {}) {
  const server = createServer({
    ...(trusted ? {
      resolveTrustedProfile: (request) => ({
        profileId: request.headers["x-test-profile"],
        scopes: (request.headers["x-test-scopes"] ?? "").split(" ").filter(Boolean)
      })
    } : {})
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try { await run(`http://127.0.0.1:${address.port}`, { trusted }); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

async function postEvent(base, preleadId, profileId, event, grantedScopes = scopes) {
  return fetch(`${base}${eventsPath(preleadId)}`, {
    method: "POST",
    headers: { ...profileHeaders(profileId, grantedScopes), "content-type": "application/json" },
    body: JSON.stringify(event)
  });
}

async function schemaValidator(name) {
  const names = [
    "prelead-event-request",
    "prelead-timeline-event",
    "prelead-event-response",
    "prelead-timeline-response",
    "prelead-event-error"
  ];
  const ajv = new Ajv();
  addFormats(ajv);
  for (const schemaName of names) {
    const schema = JSON.parse(await readFile(new URL(`../schemas/${schemaName}.schema.json`, import.meta.url)));
    ajv.addSchema(schema);
  }
  return ajv.getSchema(`https://crm-web.example.invalid/schemas/${name}.schema.json`);
}

test("one append handler records note, rejection, and undo while preserving the full timeline", async () => {
  await withServer(async (base) => {
    const preleadId = "demo-prelead-001";
    const noteRequest = { type: "note_added", noteText: "Synthetic note for the sample company.", operationId: operationId(1) };
    const rejectionRequest = { type: "rejection_added", reason: "Synthetic reason for test.", operationId: operationId(2) };
    const undoRequest = { type: "rejection_undone", targetEventId: "evt-00000000-0000-4000-8000-000000000000", operationId: operationId(3) };
    const requestValidator = await schemaValidator("prelead-event-request");
    assert.equal(requestValidator(noteRequest), true);
    assert.equal(requestValidator(rejectionRequest), true);
    assert.equal(requestValidator(undoRequest), true);
    const noteResponse = await postEvent(base, preleadId, "demo-profile-a", noteRequest);
    assert.equal(noteResponse.status, 201);
    const noteResult = await noteResponse.json();
    assert.equal(noteResult.prelead.disposition, "active");
    assert.equal(noteResult.event.type, "note_added");
    assert.equal(noteResult.operationId, operationId(1));
    assert.equal("profileId" in noteResult, false);
    assert.equal((await schemaValidator("prelead-event-response"))(noteResult), true);

    const rejectionResponse = await postEvent(base, preleadId, "demo-profile-a", rejectionRequest);
    assert.equal(rejectionResponse.status, 201);
    const rejection = await rejectionResponse.json();
    assert.equal(rejection.prelead.disposition, "rejected");

    undoRequest.targetEventId = rejection.event.eventId;
    const undoResponse = await postEvent(base, preleadId, "demo-profile-a", undoRequest);
    assert.equal(undoResponse.status, 201);
    const undone = await undoResponse.json();
    assert.equal(undone.prelead.disposition, "active");
    assert.equal(undone.event.type, "rejection_undone");
    assert.equal(undone.event.payload.targetEventId, rejection.event.eventId);

    const laterRejection = await postEvent(base, preleadId, "demo-profile-a", {
      type: "rejection_added", reason: "Synthetic later disposition.", operationId: operationId(4)
    });
    assert.equal(laterRejection.status, 201);
    assert.equal((await laterRejection.json()).prelead.disposition, "rejected");

    const timelineResponse = await fetch(`${base}${timelinePath(preleadId)}`, { headers: profileHeaders("demo-profile-a") });
    assert.equal(timelineResponse.status, 200);
    const timeline = await timelineResponse.json();
    assert.deepEqual(timeline.events.map((event) => event.type), ["note_added", "rejection_added", "rejection_undone", "rejection_added"]);
    assert.deepEqual(timeline.events.map((event) => event.sequence), [1, 2, 3, 4]);
    assert.equal(timeline.events[1].eventId, rejection.event.eventId);
    assert.equal(timeline.events[2].payload.targetEventId, timeline.events[1].eventId);
    assert.equal(timeline.prelead.disposition, "rejected");
    assert.equal((await schemaValidator("prelead-timeline-response"))(timeline), true);
  });
});

test("operation IDs make submissions idempotent; conflicts and invalid undo remain typed", async () => {
  await withServer(async (base) => {
    const preleadId = "demo-prelead-001";
    const note = { type: "note_added", noteText: "Synthetic repeated note.", operationId: operationId(10) };
    const first = await postEvent(base, preleadId, "demo-profile-a", note);
    assert.equal(first.status, 201);
    const firstResult = await first.json();
    const duplicate = await postEvent(base, preleadId, "demo-profile-a", note);
    assert.equal(duplicate.status, 200);
    const duplicateResult = await duplicate.json();
    assert.equal(duplicateResult.replayed, true);
    assert.equal(duplicateResult.event.eventId, firstResult.event.eventId);

    const conflict = await postEvent(base, preleadId, "demo-profile-a", {
      ...note, noteText: "Different synthetic note with same operation ID."
    });
    assert.equal(conflict.status, 409);
    const conflictBody = await conflict.json();
    assert.deepEqual(conflictBody, { error: "idempotency_conflict", operationId: operationId(10) });
    assert.equal((await schemaValidator("prelead-event-error"))(conflictBody), true);

    const invalidUndo = await postEvent(base, preleadId, "demo-profile-a", {
      type: "rejection_undone", targetEventId: `evt-${"0".repeat(8)}-${"0".repeat(4)}-${"0".repeat(4)}-${"0".repeat(4)}-${"0".repeat(12)}`,
      operationId: operationId(11)
    });
    assert.equal(invalidUndo.status, 409);
    const invalidUndoBody = await invalidUndo.json();
    assert.deepEqual(invalidUndoBody, { error: "undo_not_applicable", operationId: operationId(11) });
    assert.equal((await schemaValidator("prelead-event-error"))(invalidUndoBody), true);

    const timeline = await fetch(`${base}${timelinePath(preleadId)}`, { headers: profileHeaders("demo-profile-a") }).then((r) => r.json());
    assert.equal(timeline.events.length, 1);
  });
});

test("timeline reads and event writes are profile-isolated", async () => {
  await withServer(async (base) => {
    const own = await postEvent(base, "demo-prelead-001", "demo-profile-a", {
      type: "note_added", noteText: "Synthetic profile A note.", operationId: operationId(20)
    });
    assert.equal(own.status, 201);

    const hiddenTimeline = await fetch(`${base}${timelinePath("demo-prelead-001")}`, { headers: profileHeaders("demo-profile-b") });
    assert.equal(hiddenTimeline.status, 404);
    assert.deepEqual(await hiddenTimeline.json(), { error: "prelead_not_found" });
    const hiddenWrite = await postEvent(base, "demo-prelead-001", "demo-profile-b", {
      type: "note_added", noteText: "Synthetic profile B attempt.", operationId: operationId(21)
    });
    assert.equal(hiddenWrite.status, 404);
    assert.deepEqual(await hiddenWrite.json(), { error: "prelead_not_found", operationId: operationId(21) });

    const separateScope = await postEvent(base, "demo-prelead-002", "demo-profile-b", {
      type: "note_added", noteText: "Synthetic profile B note.", operationId: operationId(20)
    });
    assert.equal(separateScope.status, 201);
    assert.notEqual((await separateScope.json()).event.eventId, (await own.json()).event.eventId);
  });
});

test("timeline operations require injected trusted context and append scope; manifest omits them", async () => {
  await withServer(async (base, { trusted } = {}) => {
    const manifest = await fetch(`${base}/api/v1/manifest`).then((r) => r.json());
    assert.equal(manifest.capabilities.some((capability) => capability.id.startsWith("crm.preleads.")), false);

    const request = { type: "note_added", noteText: "Synthetic authorization test.", operationId: operationId(30) };
    const write = await postEvent(base, "demo-prelead-001", "demo-profile-a", request, ["crm.preleads.read"]);
    assert.equal(write.status, trusted === false ? 503 : 403);
    const body = await write.json();
    assert.equal(body.error, trusted === false ? "trusted_profile_unavailable" : "required_scope_missing");
  }, { trusted: false });

  await withServer(async (base) => {
    const request = { type: "note_added", noteText: "Synthetic scope test.", operationId: operationId(31) };
    const write = await postEvent(base, "demo-prelead-001", "demo-profile-a", request, ["crm.preleads.read"]);
    assert.equal(write.status, 403);
    assert.deepEqual(await write.json(), { error: "required_scope_missing" });
  });
});
