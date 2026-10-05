import { createS04D1Repository } from "../src/s04-d1-repository.js";
import { createDealReviewService } from "../src/deal-reviews.js";
import { createS04D1ConfirmedDeals } from "../src/s04-d1-confirmed-deals.js";
import { createWeeekCorrelationProvider } from "../src/weeek-correlation-provider.js";

let fakeProviderCalls = 0;
const mockWeeekDeals = new Map();
const localNow = "2026-10-06T09:00:00.000Z";

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
      if (path.startsWith("/review/") || path.startsWith("/operation/") || path === "/provider-count") {
        const profileId = request.headers.get("x-test-profile") ?? "demo-profile-a";
        const simpleProvider = { async create({ operationId, request: deal }) {
          fakeProviderCalls++;
          if (deal.title === "Unknown outcome") throw new Error("synthetic_timeout_after_reservation");
          return { status: "created", dealId: `demo-deal-${operationId.slice(3)}` };
        } };
        const transport = {
          async createDeal({ statusId, body }) {
            fakeProviderCalls++;
            const marker = body.description.match(/\[crm-web-s04:(op-[0-9a-f-]{36}):[0-9a-f]{64}\]/)?.[1];
            const deal = { id: `demo-deal-${marker?.slice(3)}`, statusId, ...body };
            mockWeeekDeals.set(deal.id, deal);
            if (body.title === "Timeout and recover") throw new Error("synthetic_timeout_after_post");
            return { success: true, deal: { id: deal.id } };
          },
          async listDeals({ statusId, limit, offset }) {
            const all = [...mockWeeekDeals.values()].filter((deal) => deal.statusId === statusId);
            return { success: true, deals: all.slice(offset, offset + limit),
              hasMoreDeals: offset + limit < all.length };
          },
          async getDeal({ dealId }) { return { success: true, deal: mockWeeekDeals.get(dealId) ?? null }; }
        };
        const provider = request.headers.get("x-test-provider-mode") === "correlation"
          ? createWeeekCorrelationProvider({ transport,
            resolveStatusIds: async (id) => id === "demo-profile-a"
              ? ["demo-status-lead-a"] : ["demo-status-lead-b"] })
          : simpleProvider;
        const confirmedDeals = createS04D1ConfirmedDeals({ repository, provider, now: () => localNow });
        const reviews = createDealReviewService({ confirmedDeals, storagePort: repository,
          now: () => localNow });
        let result;
        if (path === "/review/prepare") result = await reviews.prepare({ profileId, request: args });
        else if (path === "/review/get") result = await reviews.get({ profileId, reviewId: args.reviewId });
        else if (path === "/review/confirm") {
          if (!args || typeof args !== "object" || Array.isArray(args) ||
              Object.keys(args).some((key) => !["reviewId", "revision"].includes(key)) ||
              typeof args.reviewId !== "string" || typeof args.revision !== "string")
            return respond(400, { error: "invalid_review_confirmation" });
          // Only a test-only trusted header may mint a receipt. Body booleans are rejected.
          const approved = request.headers.get("x-test-approval") === "approved";
          const trustedReceipt = approved ? { profileId, reviewId: args.reviewId,
            revision: args.revision, actorId: "synthetic-actor", issuerId: "local-contract-harness",
            receiptId: `receipt-${args.reviewId.slice(7)}`, approved: true,
            issuedAt: localNow, expiresAt: "2027-01-01T00:00:00.000Z" } : undefined;
          result = await reviews.confirm({ profileId, reviewId: args.reviewId,
            revision: args.revision, trustedReceipt });
        } else if (path === "/operation/get") result = await confirmedDeals.get({ profileId, operationId: args.operationId });
        else if (path === "/operation/reconcile") result = await confirmedDeals.reconcile({ profileId, operationId: args.operationId });
        else return respond(200, { calls: fakeProviderCalls });
        return respond(result.status, result.body);
      }
      if (path === "/seed-prelead") {
        const result = await env.CRM_DB.prepare(`INSERT INTO s04_preleads
          (prelead_id, profile_ref, event_id, company_id, revision, created_at)
          VALUES (?, ?, ?, ?, 0, ?)`).bind(args.preleadId, args.profileRef,
          args.eventId, args.companyId, localNow).run();
        return respond(200, { changes: result.meta.changes });
      }
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
