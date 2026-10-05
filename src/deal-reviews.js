import { createHash, randomUUID } from "node:crypto";
import { catalog, companies, syntheticProfileCompanies } from "./fixtures.js";

const reviewId = () => `review-${randomUUID()}`;
const operationId = () => `op-${randomUUID()}`;
const requiredText = (value, max) => typeof value === "string" && value.trim().length > 0 && [...value.trim()].length <= max;

// The synthetic profile binding stands in for Weeek `statuses/Лид` refs.
const syntheticLeadStageIds = { "demo-profile-a": "demo-status-lead-a", "demo-profile-b": "demo-status-lead-b" };

export function normalizeDealReviewRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !["companyId", "exhibitionId", "title", "companyInn", "contactName", "dealComment"].includes(key)) ||
      !/^demo-company-[0-9]{3}$/.test(value.companyId ?? "") || !/^demo-expo-[0-9]{3}$/.test(value.exhibitionId ?? "") ||
      !requiredText(value.title, 160) || !requiredText(value.companyInn, 20) ||
      !requiredText(value.contactName, 160) || !requiredText(value.dealComment, 2000)) return null;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typeof item === "string" ? item.trim() : item]));
}

export function createDealReviewService({ confirmedDeals, preleadTimeline } = {}) {
  const reviews = new Map();
  function participant(profileId, request) {
    const visible = new Set(syntheticProfileCompanies[profileId] ?? []);
    const company = companies.find((item) => item.id === request.companyId && visible.has(item.id) && item.exhibitionIds.includes(request.exhibitionId));
    const exhibition = catalog.find((item) => item.id === request.exhibitionId);
    return company && exhibition ? { company, exhibition } : null;
  }
  function state(profileId, draft) {
    const selected = participant(profileId, draft);
    const stageId = syntheticLeadStageIds[profileId];
    if (!selected || !stageId) return null;
    const preleadId = `demo-prelead-${draft.companyId.slice(-3)}`;
    const timeline = preleadTimeline.getTimeline({ profileId, preleadId });
    if (timeline.status !== 200 || timeline.body.prelead.companyId !== draft.companyId ||
        timeline.body.prelead.exhibitionId !== draft.exhibitionId) return null;
    const notes = timeline.body.events.filter((event) => event.type === "note_added").map((event) => event.payload.noteText);
    const details = {
      companyId: draft.companyId, exhibitionId: draft.exhibitionId,
      statusId: stageId, title: draft.title, source: selected.exhibition.name,
      dealType: "direct", companyInn: draft.companyInn, contactName: draft.contactName,
      dealComment: [draft.dealComment, ...notes.map((note) => `Note: ${note}`)].join("\n"),
      notesCount: notes.length
    };
    const revision = createHash("sha256").update(JSON.stringify([profileId, details, timeline.body.events.length])).digest("hex");
    return { details, revision };
  }
  function prepare({ profileId, request }) {
    const draft = normalizeDealReviewRequest(request);
    if (!draft) return { status: 400, body: { error: "missing_or_invalid_deal_fields" } };
    const current = state(profileId, draft);
    if (!current) return { status: 404, body: { error: "company_or_exhibition_not_found" } };
    const id = reviewId();
    const review = { id, profileId, draft, operationId: operationId(), ...current };
    reviews.set(id, review);
    return { status: 201, body: { domainApiVersion: "1.0.0", reviewId: id, revision: review.revision,
      operationId: review.operationId, details: review.details, status: "prepared" } };
  }
  function get({ profileId, reviewId: id }) {
    const review = reviews.get(id);
    if (!review || review.profileId !== profileId) return { status: 404, body: { error: "review_not_found" } };
    const operation = confirmedDeals.get({ profileId, operationId: review.operationId });
    return { status: 200, body: { domainApiVersion: "1.0.0", reviewId: id, revision: review.revision,
      operationId: review.operationId, details: review.details,
      status: operation.status === 200 ? operation.body.status : "prepared",
      ...(operation.status === 200 && operation.body.dealId ? { dealId: operation.body.dealId } : {}),
      ...(operation.status === 200 && operation.body.linkStatus ? { linkStatus: operation.body.linkStatus } : {}) } };
  }
  async function confirm({ profileId, reviewId: id, revision, trustedReceipt }) {
    const review = reviews.get(id);
    if (!review || review.profileId !== profileId) return { status: 404, body: { error: "review_not_found" } };
    if (revision !== review.revision) return { status: 409, body: { error: "review_stale" } };
    if (!trustedReceipt || trustedReceipt.profileId !== profileId || trustedReceipt.reviewId !== id ||
        trustedReceipt.revision !== revision || !requiredText(trustedReceipt.actorId, 160) ||
        trustedReceipt.approved !== true) return { status: 403, body: { error: "trusted_review_confirmation_required" } };
    const prior = confirmedDeals.get({ profileId, operationId: review.operationId });
    if (prior.status !== 200 && state(profileId, review.draft)?.revision !== revision) {
      return { status: 409, body: { error: "review_stale" } };
    }
    const request = { ...review.details, summary: review.details.dealComment,
      confirmation: true, operationId: review.operationId };
    return confirmedDeals.create({ profileId, idempotencyKey: id, request });
  }
  return { prepare, get, confirm };
}
