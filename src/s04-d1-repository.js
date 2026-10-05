const syntheticDealId = (value) => typeof value === "string" &&
  /^demo-deal-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const changed = (result) => Number(result?.meta?.changes ?? 0) === 1;
const operationView = (row) => row && ({
  operationId: row.operation_id, profileRef: row.profile_ref, eventId: row.event_id,
  companyId: row.company_id, preleadId: row.prelead_id, reviewId: row.review_id,
  receiptId: row.receipt_id,
  requestHash: row.request_hash, status: row.status, dealId: row.deal_id,
  providerRef: row.provider_ref, linkStatus: row.link_status
});

// D1 binding adapter only. No live binding or provider call is created here.
export function createS04D1Repository(db) {
  if (!db?.prepare || !db?.batch) throw new Error("d1_binding_required");

  async function getOperation({ profileRef, operationId }) {
    const row = await db.prepare("SELECT * FROM s04_deal_operations WHERE profile_ref = ? AND operation_id = ?")
      .bind(profileRef, operationId).first();
    return operationView(row);
  }

  async function findParticipantOperation({ profileRef, eventId, companyId }) {
    const row = await db.prepare(`SELECT * FROM s04_deal_operations
      WHERE profile_ref = ? AND event_id = ? AND company_id = ? AND status IN ('unknown','created')
      ORDER BY created_at DESC LIMIT 1`).bind(profileRef, eventId, companyId).first();
    return operationView(row);
  }

  async function reserve({ profileRef, eventId, companyId, preleadId, reviewId, receiptId,
    operationId, revision, requestHash, now }) {
    const previous = await getOperation({ profileRef, operationId });
    if (previous) return previous.reviewId === reviewId && previous.receiptId === receiptId &&
      previous.preleadId === preleadId && previous.eventId === eventId && previous.companyId === companyId &&
      previous.requestHash === requestHash
      ? { status: "replay", operation: previous } : { status: "operation_conflict", operation: previous };
    const insert = db.prepare(`INSERT INTO s04_deal_operations
      (operation_id, profile_ref, event_id, company_id, prelead_id, review_id, receipt_id,
       request_hash, status, deal_id, provider_ref, link_status, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', NULL, NULL, 'pending', ?, ?
      FROM s04_deal_reviews r
      JOIN s04_preleads p ON p.prelead_id = r.prelead_id
      JOIN s04_review_receipts c ON c.review_id = r.review_id
      WHERE r.review_id = ? AND r.profile_ref = ? AND r.prelead_id = ?
        AND r.operation_id = ? AND r.revision = ? AND r.request_hash = ?
        AND p.profile_ref = ? AND p.event_id = ? AND p.company_id = ?
        AND p.revision = r.prelead_revision
        AND c.receipt_id = ? AND c.profile_ref = ? AND c.revision = ?
        AND c.approved = 1 AND c.actor_ref <> '' AND c.issuer_ref <> ''
        AND c.consumed_at IS NULL AND c.issued_at <= ? AND c.expires_at > ?`)
      .bind(operationId, profileRef, eventId, companyId, preleadId, reviewId, receiptId,
        requestHash, now, now, reviewId, profileRef, preleadId, operationId, revision,
        requestHash, profileRef, eventId, companyId, receiptId, profileRef, revision, now, now);
    const consume = db.prepare(`UPDATE s04_review_receipts SET consumed_at = ?
      WHERE receipt_id = ? AND consumed_at IS NULL AND EXISTS
      (SELECT 1 FROM s04_deal_operations WHERE operation_id = ? AND receipt_id = ?)`)
      .bind(now, receiptId, operationId, receiptId);
    try {
      const [inserted, consumed] = await db.batch([insert, consume]);
      if (!changed(inserted) || !changed(consumed)) return { status: "review_or_receipt_invalid" };
      return { status: "reserved_unknown", dispatchAllowed: true,
        operation: await getOperation({ profileRef, operationId }) };
    } catch {
      const own = await getOperation({ profileRef, operationId });
      if (own) return own.reviewId === reviewId && own.receiptId === receiptId &&
        own.preleadId === preleadId && own.eventId === eventId && own.companyId === companyId &&
        own.requestHash === requestHash
        ? { status: "replay", operation: own } : { status: "operation_conflict", operation: own };
      const other = await findParticipantOperation({ profileRef, eventId, companyId });
      if (other) return { status: "participant_deal_exists", operation: other };
      return { status: "storage_unavailable" };
    }
  }

  async function recordCreated({ profileRef, operationId, dealId, providerRef = null, now }) {
    if (!syntheticDealId(dealId)) return { status: "invalid_deal_id" };
    const result = await db.prepare(`UPDATE s04_deal_operations SET status = 'created', deal_id = ?,
      provider_ref = ?, updated_at = ? WHERE profile_ref = ? AND operation_id = ? AND status = 'unknown'`)
      .bind(dealId, providerRef, now, profileRef, operationId).run();
    if (changed(result)) return { status: "created", operation: await getOperation({ profileRef, operationId }) };
    const current = await getOperation({ profileRef, operationId });
    return current?.status === "created" && current.dealId === dealId
      ? { status: "replay", operation: current }
      : { status: current ? "outcome_conflict" : "operation_not_found", operation: current };
  }

  async function linkVerifiedDeal({ profileRef, operationId, now }) {
    const operation = await getOperation({ profileRef, operationId });
    if (!operation) return { status: "operation_not_found" };
    if (operation.status !== "created" || !syntheticDealId(operation.dealId)) return { status: "created_deal_required" };
    const eventId = `evt-link-${operationId}`;
    const existing = await db.prepare("SELECT payload_json FROM s04_prelead_events WHERE event_id = ? AND prelead_id = ?")
      .bind(eventId, operation.preleadId).first();
    if (existing) return operation.linkStatus === "linked" && JSON.parse(existing.payload_json).dealId === operation.dealId
      ? { status: "replay", operation } : { status: "link_conflict" };
    const payload = JSON.stringify({ dealId: operation.dealId });
    const insert = db.prepare(`INSERT INTO s04_prelead_events
      (event_id, prelead_id, profile_ref, operation_id, sequence, kind, payload_json, created_at)
      SELECT ?, p.prelead_id, o.profile_ref, o.operation_id, p.revision + 1, 'deal_linked', ?, ?
      FROM s04_deal_operations o JOIN s04_preleads p ON p.prelead_id = o.prelead_id
      WHERE o.operation_id = ? AND o.profile_ref = ? AND o.status = 'created' AND o.deal_id = ?
        AND p.profile_ref = o.profile_ref AND p.event_id = o.event_id AND p.company_id = o.company_id`)
      .bind(eventId, payload, now, operationId, profileRef, operation.dealId);
    const advance = db.prepare(`UPDATE s04_preleads SET revision = revision + 1
      WHERE prelead_id = ? AND profile_ref = ? AND EXISTS
      (SELECT 1 FROM s04_prelead_events WHERE event_id = ? AND prelead_id = ?)`)
      .bind(operation.preleadId, profileRef, eventId, operation.preleadId);
    const mark = db.prepare(`UPDATE s04_deal_operations SET link_status = 'linked', updated_at = ?
      WHERE operation_id = ? AND profile_ref = ? AND status = 'created' AND EXISTS
      (SELECT 1 FROM s04_prelead_events WHERE event_id = ? AND prelead_id = ?)`)
      .bind(now, operationId, profileRef, eventId, operation.preleadId);
    try {
      const [inserted, advanced, marked] = await db.batch([insert, advance, mark]);
      if (!changed(inserted) || !changed(advanced) || !changed(marked)) return { status: "link_incomplete" };
      return { status: "linked", operation: await getOperation({ profileRef, operationId }) };
    } catch {
      const event = await db.prepare("SELECT payload_json FROM s04_prelead_events WHERE event_id = ? AND prelead_id = ?")
        .bind(eventId, operation.preleadId).first();
      const current = await getOperation({ profileRef, operationId });
      return event && current?.linkStatus === "linked" && JSON.parse(event.payload_json).dealId === operation.dealId
        ? { status: "replay", operation: current } : { status: "link_conflict" };
    }
  }

  return { reserve, getOperation, findParticipantOperation, recordCreated, linkVerifiedDeal };
}
