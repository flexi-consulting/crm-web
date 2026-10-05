// Local contract adapter. The repository owns the reservation before the fake
// provider is called; an unknown outcome is never dispatched a second time.
export function createS04D1ConfirmedDeals({ repository, provider, now = () => new Date().toISOString() }) {
  const view = (op, replayed = false) => ({ domainApiVersion: "1.0.0", operationId: op.operationId,
    status: op.status, companyId: op.companyId, exhibitionId: op.eventId,
    ...(op.dealId ? { dealId: op.dealId } : {}), linkStatus: op.linkStatus, replayed });
  async function get({ profileId, operationId }) {
    const op = await repository.getOperation({ profileRef: profileId, operationId });
    return op ? { status: 200, body: view(op) } : { status: 404, body: { error: "operation_not_found", operationId } };
  }
  async function create({ profileId, idempotencyKey, request, reviewEvidence }) {
    // Evidence is supplied by the reviewed domain handler, never by a direct HTTP body.
    if (!reviewEvidence || idempotencyKey !== reviewEvidence.reviewId ||
        request.operationId !== reviewEvidence.operationId ||
        request.companyId !== reviewEvidence.companyId || request.exhibitionId !== reviewEvidence.eventId) {
      return { status: 403, body: { error: "trusted_review_confirmation_required" } };
    }
    const reserved = await repository.reserve({ profileRef: profileId, eventId: request.exhibitionId,
      companyId: request.companyId, preleadId: reviewEvidence.preleadId,
      reviewId: reviewEvidence.reviewId, receiptId: reviewEvidence.receiptId,
      operationId: request.operationId, revision: reviewEvidence.revision,
      requestHash: reviewEvidence.requestHash, now: now() });
    if (reserved.status === "replay") return { status: reserved.operation.status === "created" ? 200 : 202,
      body: view(reserved.operation, true) };
    if (reserved.status !== "reserved_unknown") return { status: reserved.status === "storage_unavailable" ? 503 : 409,
      body: { error: reserved.status, operationId: request.operationId } };
    let outcome;
    try { outcome = await provider.create({ operationId: request.operationId, request }); }
    catch { return { status: 202, body: view(reserved.operation) }; }
    if (outcome?.status !== "created") return { status: 202, body: view(reserved.operation) };
    const recorded = await repository.recordCreated({ profileRef: profileId,
      operationId: request.operationId, dealId: outcome.dealId, now: now() });
    if (recorded.status !== "created" && recorded.status !== "replay")
      return { status: 202, body: view(reserved.operation) };
    const linked = await repository.linkVerifiedDeal({ profileRef: profileId,
      operationId: request.operationId, now: now() });
    const operation = linked.operation ?? await repository.getOperation({ profileRef: profileId,
      operationId: request.operationId });
    return { status: 201, body: view(operation) };
  }
  async function repair({ profileId, operationId }) {
    const op = await repository.getOperation({ profileRef: profileId, operationId });
    if (!op) return { status: 404, body: { error: "operation_not_found", operationId } };
    if (op.status !== "created") return { status: 409, body: { error: "created_deal_required", operationId } };
    const linked = await repository.linkVerifiedDeal({ profileRef: profileId, operationId, now: now() });
    return linked.status === "linked" || linked.status === "replay"
      ? { status: 200, body: view(linked.operation) }
      : { status: 409, body: { error: linked.status, operationId } };
  }
  // A provider read needs a durable correlation contract; absent that, unknown
  // remains unknown and no second create can occur.
  async function reconcile({ profileId, operationId }) { return get({ profileId, operationId }); }
  return { create, get, repair, reconcile };
}
