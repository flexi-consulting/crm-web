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
  async function recordVerified({ profileId, operationId, outcome }) {
    const recorded = await repository.recordCreated({ profileRef: profileId, operationId,
      dealId: outcome.dealId, providerRef: outcome.providerRef ?? null, now: now() });
    if (recorded.status !== "created" && recorded.status !== "replay")
      return { status: 202, body: view(await repository.getOperation({ profileRef: profileId, operationId })) };
    const linked = await repository.linkVerifiedDeal({ profileRef: profileId, operationId, now: now() });
    const operation = linked.operation ?? await repository.getOperation({ profileRef: profileId, operationId });
    return { status: 200, body: view(operation) };
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
    try { outcome = await provider.create({ profileId, operationId: request.operationId,
      request, requestHash: reviewEvidence.requestHash }); }
    catch { return { status: 202, body: view(reserved.operation) }; }
    if (outcome?.status !== "created") return { status: 202, body: view(reserved.operation) };
    const result = await recordVerified({ profileId, operationId: request.operationId, outcome });
    return result.status === 200 ? { ...result, status: 201 } : result;
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
  async function reconcile({ profileId, operationId }) {
    const operation = await repository.getOperation({ profileRef: profileId, operationId });
    if (!operation) return { status: 404, body: { error: "operation_not_found", operationId } };
    if (operation.status !== "unknown") return { status: 200, body: view(operation) };
    if (typeof provider.reconcile !== "function")
      return { status: 202, body: { ...view(operation), reason: "correlation_unavailable" } };
    const review = await repository.getReview({ profileRef: profileId, reviewId: operation.reviewId });
    if (!review || review.operationId !== operationId || review.requestHash !== operation.requestHash ||
        !review.snapshot?.details || review.snapshot.details.companyId !== operation.companyId ||
        review.snapshot.details.exhibitionId !== operation.eventId)
      return { status: 202, body: { ...view(operation), reason: "review_binding_unavailable" } };
    let result;
    try { result = await provider.reconcile({ profileId, operationId,
      requestHash: operation.requestHash, request: review.snapshot.details }); }
    catch { return { status: 202, body: { ...view(operation), reason: "provider_unavailable" } }; }
    if (result?.status !== "created") return { status: 202, body: { ...view(operation),
      reason: result?.reason ?? "correlation_unresolved" } };
    return recordVerified({ profileId, operationId, outcome: result });
  }
  return { create, get, repair, reconcile };
}
