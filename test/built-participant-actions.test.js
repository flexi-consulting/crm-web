import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { createServer } from "../src/server.js";
import { createCatalogBuildService } from "../src/catalog-build.js";
import { createPreleadTimelineService } from "../src/prelead-timeline.js";
import { createParticipantResolver } from "../src/participant-resolver.js";
import { createConfirmedDealService, FakeDealProvider } from "../src/confirmed-deals.js";
import { createDealReviewService } from "../src/deal-reviews.js";
import { createOfflineS04McpServer } from "../src/s04-deals.js";

const allScopes = ["crm.catalog.build.synthetic", "crm.catalog.build.read.synthetic", "crm.preleads.create.synthetic",
  "crm.preleads.events.append", "crm.preleads.read", "crm.deals.review.synthetic", "crm.deals.confirm.synthetic",
  "crm.deals.operations.read.synthetic"];
const post = (base, path, body, headers = {}) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const rpc = async (mcp, name, args) => JSON.parse(await mcp.receive({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args, _meta: { capabilityVersion: "1.0.0" } } }));

async function fixture(run) {
  const catalogBuilds = createCatalogBuildService();
  const preleadTimeline = createPreleadTimelineService();
  const participantResolver = createParticipantResolver({ catalogBuilds, preleadTimeline });
  const provider = new FakeDealProvider();
  const dealService = createConfirmedDealService({ provider, preleadTimeline, participantResolver });
  const reviewService = createDealReviewService({ confirmedDeals: dealService, preleadTimeline, participantResolver });
  let currentProfile = "demo-profile-a";
  let currentScopes = allScopes;
  let approval = null;
  const resolveTrustedProfile = () => ({ profileId: currentProfile, scopes: currentScopes });
  const resolveTrustedReviewReceipt = () => approval;
  const server = createServer({ catalogBuilds, preleadTimeline, confirmedDeals: dealService, reviewService,
    resolveTrustedProfile, resolveTrustedReviewReceipt });
  const mcp = createOfflineS04McpServer({ dealService, reviewService, resolveTrustedProfile, resolveTrustedReviewReceipt });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run({ base, mcp, provider, setProfile: (value) => { currentProfile = value; },
    setScopes: (value) => { currentScopes = value; }, setApproval: (value) => { approval = value; } }); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

test("built participant flows from card to profile-owned note and reviewed fake deal over HTTP/MCP", async () => {
  await fixture(async ({ base, mcp, provider, setApproval, setProfile }) => {
    const buildResponse = await post(base, "/api/v1/catalog-builds", { exhibitionId: "demo-expo-001" }, { "idempotency-key": "catalog-action-01" });
    assert.equal(buildResponse.status, 201);
    const { buildId } = await buildResponse.json();
    const list = await fetch(`${base}/api/v1/catalog-builds/${buildId}/participants?classification=target`).then((response) => response.json());
    assert.equal(list.items.length, 1);
    const company = list.items[0];
    assert.deepEqual((await fetch(`${base}${company.detailPath}`).then((response) => response.json())).items, [company]);
    const preleadPath = `${company.detailPath}/prelead`;
    const bound = await post(base, preleadPath, {});
    assert.equal(bound.status, 201);
    const { prelead } = await bound.json();
    assert.equal(prelead.companyId, company.id);
    assert.equal(prelead.buildId, buildId);
    const ajv = new Ajv();
    addFormats(ajv);
    for (const name of ["prelead-event-response", "prelead-timeline-event", "built-prelead-response"]) {
      ajv.addSchema(JSON.parse(await readFile(new URL(`../schemas/${name}.schema.json`, import.meta.url))));
    }
    const validBinding = ajv.getSchema("https://crm-web.example.invalid/schemas/built-prelead-response.schema.json");
    assert.ok(validBinding({ domainApiVersion: "1.0.0", prelead, replayed: false }), JSON.stringify(validBinding.errors));
    assert.equal((await post(base, preleadPath, {})).status, 200);
    const note = await post(base, `/api/v1/preleads/${prelead.id}/events`, { type: "note_added", noteText: "Synthetic buyer interest", operationId: `op-${randomUUID()}` });
    assert.equal(note.status, 201);
    const noteBody = await note.json();
    assert.equal(noteBody.prelead.buildId, buildId);
    const draft = { buildId, companyId: company.id, exhibitionId: "demo-expo-001", title: "Synthetic pilot",
      companyInn: "0000000001", contactName: "Example Contact", dealComment: "Discuss sample offer" };
    const httpReview = await post(base, "/api/v1/deal-reviews", draft);
    assert.equal(httpReview.status, 201);
    const review = await httpReview.json();
    assert.equal(review.details.buildId, buildId);
    assert.equal(review.details.notesCount, 1);
    assert.match(review.details.dealComment, /Synthetic buyer interest/);
    assert.equal(review.details.source, "Example Industry Expo");
    assert.equal(provider.operations.size, 0);
    await mcp.receive({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    await mcp.receive({ jsonrpc: "2.0", method: "notifications/initialized" });
    const mcpReview = await rpc(mcp, "crm_deal_prepare_from_participant", draft);
    assert.deepEqual(mcpReview.result.structuredContent.details, review.details);
    const denied = await rpc(mcp, "crm_deal_create_from_participant", { reviewId: review.reviewId, revision: review.revision });
    assert.equal(denied.error.message, "trusted_review_confirmation_required");
    assert.equal(provider.operations.size, 0);
    setApproval({ profileId: "demo-profile-a", reviewId: review.reviewId, revision: review.revision, actorId: "synthetic-actor", approved: true });
    const created = await rpc(mcp, "crm_deal_create_from_participant", { reviewId: review.reviewId, revision: review.revision });
    assert.equal(created.result.structuredContent.status, "created");
    assert.equal(created.result.structuredContent.linkStatus, "linked");
    assert.equal(created.result.structuredContent.buildId, buildId);
    assert.equal(provider.operations.size, 1);
    const replay = await post(base, `/api/v1/deal-reviews/${review.reviewId}/confirm`, { revision: review.revision });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).dealId, created.result.structuredContent.dealId);
    assert.equal(provider.operations.size, 1);
    const timeline = await fetch(`${base}/api/v1/preleads/${prelead.id}/timeline`).then((response) => response.json());
    assert.equal(timeline.prelead.disposition, "deal");
    assert.deepEqual(timeline.events.map((event) => event.type), ["note_added", "deal_linked"]);
    setProfile("demo-profile-b");
    assert.equal((await fetch(`${base}${company.detailPath}`)).status, 404);
    assert.equal((await fetch(`${base}/api/v1/preleads/${prelead.id}/timeline`)).status, 404);
    assert.equal((await fetch(`${base}/api/v1/deal-reviews/${review.reviewId}`)).status, 404);
  });
});

test("built participant revision and ownership are required before notes or deal review", async () => {
  await fixture(async ({ base, provider, setProfile, setScopes }) => {
    const built = await (await post(base, "/api/v1/catalog-builds", { exhibitionId: "demo-expo-001" }, { "idempotency-key": "catalog-action-02" })).json();
    const company = (await fetch(`${base}/api/v1/catalog-builds/${built.buildId}/participants?classification=target`).then((response) => response.json())).items[0];
    const draft = { buildId: built.buildId, companyId: company.id, exhibitionId: "demo-expo-001", title: "Synthetic",
      companyInn: "0000000001", contactName: "Example", dealComment: "Sample" };
    assert.equal((await post(base, "/api/v1/deal-reviews", draft)).status, 404);
    assert.equal((await post(base, "/api/v1/deal-reviews", { ...draft, buildId: undefined })).status, 400);
    assert.equal((await post(base, "/api/v1/deal-reviews", { ...draft, exhibitionId: "demo-expo-002" })).status, 404);
    setProfile("demo-profile-b");
    assert.equal((await post(base, `${company.detailPath}/prelead`, {})).status, 404);
    setProfile("demo-profile-a");
    setScopes([]);
    assert.equal((await post(base, `${company.detailPath}/prelead`, {})).status, 403);
    assert.equal(provider.operations.size, 0);
  });
});

test("a new built-participant note invalidates an unconfirmed review before fake provider effect", async () => {
  await fixture(async ({ base, provider, setApproval }) => {
    const built = await (await post(base, "/api/v1/catalog-builds", { exhibitionId: "demo-expo-001" }, { "idempotency-key": "catalog-action-03" })).json();
    const company = (await fetch(`${base}/api/v1/catalog-builds/${built.buildId}/participants?classification=target`).then((response) => response.json())).items[0];
    const binding = await (await post(base, `${company.detailPath}/prelead`, {})).json();
    const draft = { buildId: built.buildId, companyId: company.id, exhibitionId: "demo-expo-001", title: "Synthetic",
      companyInn: "0000000001", contactName: "Example", dealComment: "Sample" };
    const review = await (await post(base, "/api/v1/deal-reviews", draft)).json();
    await post(base, `/api/v1/preleads/${binding.prelead.id}/events`, { type: "note_added", noteText: "New synthetic context", operationId: `op-${randomUUID()}` });
    setApproval({ profileId: "demo-profile-a", reviewId: review.reviewId, revision: review.revision, actorId: "synthetic-actor", approved: true });
    const stale = await post(base, `/api/v1/deal-reviews/${review.reviewId}/confirm`, { revision: review.revision });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error, "review_stale");
    assert.equal(provider.operations.size, 0);
  });
});

test("two catalog builds cannot create two deals for the same profile/event/company", async () => {
  await fixture(async ({ base, provider, setApproval }) => {
    const builds = [];
    for (const key of ["catalog-action-04-a", "catalog-action-04-b"]) {
      const build = await (await post(base, "/api/v1/catalog-builds", { exhibitionId: "demo-expo-001" }, { "idempotency-key": key })).json();
      const company = (await fetch(`${base}/api/v1/catalog-builds/${build.buildId}/participants?classification=target`).then((response) => response.json())).items[0];
      await post(base, `${company.detailPath}/prelead`, {});
      const draft = { buildId: build.buildId, companyId: company.id, exhibitionId: "demo-expo-001", title: "Synthetic",
        companyInn: "0000000001", contactName: "Example", dealComment: "Sample" };
      const review = await (await post(base, "/api/v1/deal-reviews", draft)).json();
      builds.push({ build, company, review });
    }
    assert.equal(builds[0].company.id, builds[1].company.id);
    for (const [index, item] of builds.entries()) {
      setApproval({ profileId: "demo-profile-a", reviewId: item.review.reviewId, revision: item.review.revision,
        actorId: "synthetic-actor", approved: true });
      const response = await post(base, `/api/v1/deal-reviews/${item.review.reviewId}/confirm`, { revision: item.review.revision });
      assert.equal(response.status, index === 0 ? 201 : 409);
      if (index === 1) assert.equal((await response.json()).error, "review_stale");
    }
    const second = builds[1];
    const freshReview = await (await post(base, "/api/v1/deal-reviews", { buildId: second.build.buildId,
      companyId: second.company.id, exhibitionId: "demo-expo-001", title: "Synthetic",
      companyInn: "0000000001", contactName: "Example", dealComment: "Sample" })).json();
    setApproval({ profileId: "demo-profile-a", reviewId: freshReview.reviewId, revision: freshReview.revision,
      actorId: "synthetic-actor", approved: true });
    const duplicate = await post(base, `/api/v1/deal-reviews/${freshReview.reviewId}/confirm`, { revision: freshReview.revision });
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).error, "participant_deal_exists");
    assert.equal(provider.operations.size, 1);
  });
});

test("rebuild preserves the same profile/event/company prelead history for new review", async () => {
  await fixture(async ({ base }) => {
    const selected = [];
    for (const key of ["catalog-rebuild-01", "catalog-rebuild-02"]) {
      const build = await (await post(base, "/api/v1/catalog-builds", { exhibitionId: "demo-expo-001" }, { "idempotency-key": key })).json();
      const company = (await fetch(`${base}/api/v1/catalog-builds/${build.buildId}/participants?classification=target`).then((response) => response.json())).items[0];
      const response = await post(base, `${company.detailPath}/prelead`, {});
      const binding = await response.json();
      selected.push({ build, company, binding });
      if (selected.length === 1) {
        const note = await post(base, `/api/v1/preleads/${binding.prelead.id}/events`,
          { type: "note_added", noteText: "Remember this synthetic interest", operationId: `op-${randomUUID()}` });
        assert.equal(note.status, 201);
      }
    }
    assert.equal(selected[0].binding.prelead.id, selected[1].binding.prelead.id);
    assert.equal(selected[1].binding.replayed, false);
    assert.deepEqual(selected[1].binding.prelead.sourceBuildIds, selected.map((item) => item.build.buildId));
    const timeline = await fetch(`${base}/api/v1/preleads/${selected[1].binding.prelead.id}/timeline`).then((response) => response.json());
    assert.equal(timeline.events.length, 1);
    assert.equal(timeline.events[0].payload.noteText, "Remember this synthetic interest");
    const second = selected[1];
    const review = await post(base, "/api/v1/deal-reviews", { buildId: second.build.buildId, companyId: second.company.id,
      exhibitionId: "demo-expo-001", title: "Synthetic", companyInn: "0000000001", contactName: "Example", dealComment: "Sample" });
    assert.equal(review.status, 201);
    assert.match((await review.json()).details.dealComment, /Remember this synthetic interest/);
  });
});
