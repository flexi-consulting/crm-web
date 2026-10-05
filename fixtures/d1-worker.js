import { createS04D1Repository } from "../src/s04-d1-repository.js";

const respond = (status, body) => new Response(JSON.stringify(body), { status,
  headers: { "content-type": "application/json", "cache-control": "no-store" } });

// Local Wrangler contract harness only; never deploy this Worker.
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/health") return respond(200, { ok: true });
    let args;
    try { args = await request.json(); } catch { return respond(400, { error: "invalid_json" }); }
    const repository = createS04D1Repository(env.CRM_DB);
    try {
      if (path === "/seed") {
        const db = env.CRM_DB;
        await db.batch([
          db.prepare(`INSERT INTO s04_preleads
            (prelead_id, profile_ref, event_id, company_id, revision, created_at)
            VALUES (?, ?, ?, ?, 0, ?)`).bind(args.preleadId, args.profileRef, args.eventId, args.companyId, args.now),
          db.prepare(`INSERT INTO s04_deal_reviews
            (review_id, profile_ref, prelead_id, prelead_revision, revision, request_hash,
             snapshot_json, operation_id, created_at)
            VALUES (?, ?, ?, 0, ?, ?, '{}', ?, ?)`)
            .bind(args.reviewId, args.profileRef, args.preleadId, args.revision, args.requestHash, args.operationId, args.now),
          db.prepare(`INSERT INTO s04_review_receipts
            (receipt_id, review_id, profile_ref, revision, actor_ref, issuer_ref,
             approved, issued_at, expires_at)
            VALUES (?, ?, ?, ?, 'synthetic-actor', 'synthetic-issuer', 1, ?, ?)`)
            .bind(args.receiptId, args.reviewId, args.profileRef, args.revision, args.now, args.expiresAt)
        ]);
        return respond(200, { ok: true });
      }
      if (path === "/seed-review") {
        const db = env.CRM_DB;
        await db.batch([
          db.prepare(`INSERT INTO s04_deal_reviews
            (review_id, profile_ref, prelead_id, prelead_revision, revision, request_hash,
             snapshot_json, operation_id, created_at)
            SELECT ?, ?, prelead_id, revision, ?, ?, '{}', ?, ? FROM s04_preleads
            WHERE prelead_id = ? AND profile_ref = ?`)
            .bind(args.reviewId, args.profileRef, args.revision, args.requestHash, args.operationId,
              args.now, args.preleadId, args.profileRef),
          db.prepare(`INSERT INTO s04_review_receipts
            (receipt_id, review_id, profile_ref, revision, actor_ref, issuer_ref,
             approved, issued_at, expires_at)
            VALUES (?, ?, ?, ?, 'synthetic-actor', 'synthetic-issuer', 1, ?, ?)`)
            .bind(args.receiptId, args.reviewId, args.profileRef, args.revision, args.now, args.expiresAt)
        ]);
        return respond(200, { ok: true });
      }
      if (path === "/advance-prelead") {
        const result = await env.CRM_DB.prepare("UPDATE s04_preleads SET revision = revision + 1 WHERE prelead_id = ?")
          .bind(args.preleadId).run();
        return respond(200, { changes: result.meta.changes });
      }
      if (path === "/reserve") return respond(200, await repository.reserve(args));
      if (path === "/created") return respond(200, await repository.recordCreated(args));
      if (path === "/link") return respond(200, await repository.linkVerifiedDeal(args));
      if (path === "/get") return respond(200, await repository.getOperation(args));
      if (path === "/events") {
        const events = await env.CRM_DB.prepare("SELECT event_id, kind, payload_json FROM s04_prelead_events WHERE prelead_id = ? ORDER BY sequence")
          .bind(args.preleadId).all();
        const prelead = await env.CRM_DB.prepare("SELECT revision FROM s04_preleads WHERE prelead_id = ?")
          .bind(args.preleadId).first();
        return respond(200, { events: events.results, revision: prelead?.revision });
      }
      if (path === "/fail-link-update") {
        await env.CRM_DB.prepare(`CREATE TRIGGER s04_test_fail_link BEFORE UPDATE ON s04_preleads
          BEGIN SELECT RAISE(ABORT, 'synthetic_link_update_failure'); END`).run();
        return respond(200, { ok: true });
      }
      if (path === "/clear-fail-link-update") {
        await env.CRM_DB.prepare("DROP TRIGGER IF EXISTS s04_test_fail_link").run();
        return respond(200, { ok: true });
      }
      return respond(404, { error: "not_found" });
    } catch (error) { return respond(500, { error: "contract_harness_failure", detail: String(error?.message ?? error) }); }
  }
};
