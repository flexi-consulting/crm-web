import { createS04D1Repository } from "./s04-d1-repository.js";

const HEX = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const RECEIPT_RETENTION_SECONDS = 90 * 24 * 60 * 60;
const OPERATION_FIELDS = new Set(["companyId", "exhibitionId", "buildId", "statusId", "title", "source",
  "dealType", "companyInn", "contactName", "dealComment", "notesCount"]);
function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    throw new TypeError("invalid_approval_operation");
  const keys = Object.keys(value);
  if (keys.some((key) => ["__proto__", "prototype", "constructor"].includes(key)))
    throw new TypeError("invalid_approval_operation");
  const entries = keys.sort().map((key) => [key, canonical(value[key])]);
  return Object.fromEntries(entries);
}
const stable = (value) => JSON.stringify(canonical(value));
async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function requestHash(operation, sourceRevision) {
  return sha256(JSON.stringify({ audience: "crm-web", clientId: "crm-web",
    commandId: "crm.deals.create", operation: canonical(operation), sourceRevision }));
}
function tokenOf(request) {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([a-f0-9]{64})$/.exec(authorization);
  return match?.[1] ?? null;
}
function expiryText(seconds) { return new Date(seconds * 1000).toISOString(); }

/** Server-side CP approval flow; all browser identity and payload fields are re-read from trusted state. */
export function createConnectedAppDealApproval({ db, issuer, prepareApproval, consumeApproval, now = () => Date.now() } = {}) {
  if (!db?.prepare || typeof prepareApproval !== "function" || typeof consumeApproval !== "function" ||
      typeof issuer !== "string" || !issuer.startsWith("https://")) throw new TypeError("approval_ports_required");
  const repository = createS04D1Repository(db);
  return async ({ request, identity, reviewId, revision, review }) => {
    const token = tokenOf(request);
    if (!token || !identity || !ID.test(identity.profileId ?? "") || !ID.test(identity.principalId ?? "") ||
        !review || review.reviewId !== reviewId || review.revision !== revision ||
        !ID.test(review.operationId ?? "") || !HEX.test(review.requestHash ?? "") ||
        !review.details || Object.keys(review.details).some((key) => !OPERATION_FIELDS.has(key)) ||
        [...OPERATION_FIELDS].filter((key) => key !== "buildId").some((key) => review.details[key] === undefined) ||
        Object.entries(review.details).some(([key, value]) => key === "notesCount"
          ? !Number.isSafeInteger(value) || value < 0
          : typeof value !== "string" || !value.trim()))
      throw new Error("approval_context_invalid");
    const payloadHash = await requestHash(review.details, revision);
    let stored = await repository.getCpApprovalIntent({ profileRef: identity.profileId, reviewId });
    const nowSeconds = Math.floor(now() / 1000);
    const matchesReview = (intent) => intent && intent.revision === revision &&
      intent.operation_id === review.operationId && intent.request_hash === payloadHash &&
      HEX.test(intent.intent_id ?? "");
    const approvalUrlOf = (intent) => {
      const target = new URL(intent.approval_url);
      if (target.origin !== issuer || target.pathname !== "/v1/connected-app-approvals/review" ||
          target.searchParams.getAll("intent").length !== 1 || target.searchParams.get("intent") !== intent.intent_id ||
          [...target.searchParams.keys()].some((key) => key !== "intent"))
        throw new Error("approval_intent_url_invalid");
      return target.href;
    };
    const consumeStored = async (intent) => {
      const consumed = await consumeApproval({ token, intentId: intent.intent_id,
        consumerRequestId: review.operationId, operation: review.details, sourceRevision: revision });
      if (consumed?.status === 403 && consumed.body?.error === "human approval required")
        return intent.expires_at > nowSeconds
          ? { pending: true, approvalUrl: approvalUrlOf(intent) }
          : { expired: true };
      if (consumed?.status === 403 && consumed.body?.error === "approval not available" &&
          intent.expires_at <= nowSeconds) return { expired: true };
      const receipt = consumed?.body?.receipt;
      if (consumed?.status !== 201 && consumed?.status !== 200) throw new Error("approval_consume_unavailable");
      if (consumed.body?.version !== 1 || !receipt || !HEX.test(receipt.receiptId ?? "") ||
          receipt.audience !== "crm-web" || receipt.clientId !== "crm-web" ||
          receipt.command !== "crm.deals.create" || receipt.requestHash !== payloadHash ||
          receipt.sourceRevision !== revision || receipt.profileId !== identity.profileId ||
          receipt.principalId !== identity.principalId || !Number.isSafeInteger(receipt.approvedAt) ||
          !Number.isSafeInteger(receipt.consumedAt) || stable(receipt.operation) !== stable(review.details))
        throw new Error("approval_receipt_binding_invalid");
      return { receipt, approvalUrl: approvalUrlOf(intent) };
    };

    if (stored && (stored.profile_ref !== identity.profileId || !matchesReview(stored)))
      throw new Error("approval_intent_binding_invalid");

    // CP can replay the same durable receipt for 90 days after a consume response
    // is lost. Try that recovery before replacing an intent whose ten-minute
    // approval window elapsed; CP checks consumed intents before their expiry.
    if (stored && stored.expires_at <= nowSeconds) {
      const recovered = await consumeStored(stored);
      if (recovered.receipt) return {
        profileId: recovered.receipt.profileId, reviewId, revision,
        actorId: recovered.receipt.principalId, issuerId: issuer,
        receiptId: recovered.receipt.receiptId, approved: true,
        issuedAt: expiryText(recovered.receipt.approvedAt),
        expiresAt: expiryText(recovered.receipt.consumedAt + RECEIPT_RETENTION_SECONDS)
      };
      if (!recovered.expired) throw new Error("approval_consume_unavailable");
      stored = null;
    }

    if (!stored) {
      const prepared = await prepareApproval({ token, operation: review.details, sourceRevision: revision });
      if (!prepared || prepared.version !== 1 || !HEX.test(prepared.intentId) ||
          !Number.isSafeInteger(prepared.expiresAt) || prepared.expiresAt <= nowSeconds ||
          prepared.expiresAt > nowSeconds + 600) throw new Error("approval_prepare_invalid");
      const saved = await repository.saveCpApprovalIntent({ profileRef: identity.profileId, reviewId,
        revision, operationId: review.operationId, requestHash: payloadHash,
        intentId: prepared.intentId, approvalUrl: prepared.approvalUrl,
        expiresAt: prepared.expiresAt, createdAt: nowSeconds });
      if (saved.status !== "saved" && saved.status !== "existing") throw new Error("approval_intent_persist_failed");
      stored = saved.intent;
    }
    if (!matchesReview(stored) || stored.expires_at <= nowSeconds)
      throw new Error("approval_intent_binding_invalid");
    const result = await consumeStored(stored);
    if (result.pending) return { approvalPending: true, approvalUrl: result.approvalUrl };
    if (!result.receipt) throw new Error("approval_consume_unavailable");
    return { profileId: result.receipt.profileId, reviewId, revision, actorId: result.receipt.principalId,
      issuerId: issuer, receiptId: result.receipt.receiptId, approved: true,
      issuedAt: expiryText(result.receipt.approvedAt),
      expiresAt: expiryText(result.receipt.consumedAt + RECEIPT_RETENTION_SECONDS) };
  };
}
