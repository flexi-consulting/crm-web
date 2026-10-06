import { randomUUID } from "node:crypto";
import { catalog, syntheticProfileCompanies, companies } from "./fixtures.js";

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keyFor = (profileId, key) => `${profileId}\u0000${key}`;
const isDealId = (value) => typeof value === "string" && /^demo-deal-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

// In-memory fake provider. Tests may inject an adapter with the same methods.
export class FakeDealProvider {
  operations = new Map();
  async create({ operationId, request }) {
    const current = this.operations.get(operationId);
    if (current) return { status: current.status, dealId: current.dealId };
    const created = { status: "created", dealId: `demo-deal-${randomUUID()}`, request: structuredClone(request) };
    this.operations.set(operationId, created);
    return { status: "created", dealId: created.dealId };
  }
  async reconcile(operationId) {
    const current = this.operations.get(operationId);
    return current ? { status: current.status, dealId: current.dealId } : { status: "unknown" };
  }
  async repairLink(operationId, dealId) {
    const current = this.operations.get(operationId);
    if (!current || current.status !== "created" || current.dealId !== dealId) return false;
    current.linked = true;
    return true;
  }
}

export function normalizeConfirmedDealRequest(v) {
  if (!v || typeof v !== "object" || Array.isArray(v) ||
      Object.keys(v).some((k) => !["companyId", "exhibitionId", "title", "summary", "confirmation", "operationId"].includes(k)) ||
      v.confirmation !== true || typeof v.companyId !== "string" || !/^demo-company-[0-9]{3}$/.test(v.companyId) ||
      typeof v.exhibitionId !== "string" || !/^demo-expo-[0-9]{3}$/.test(v.exhibitionId) ||
      typeof v.title !== "string" || !v.title.trim() || [...v.title.trim()].length > 160 ||
      typeof v.summary !== "string" || !v.summary.trim() || [...v.summary.trim()].length > 2000 ||
      typeof v.operationId !== "string" || !/^op-[0-9a-f-]{36}$/.test(v.operationId)) return null;
  return { companyId: v.companyId, exhibitionId: v.exhibitionId, title: v.title.trim(), summary: v.summary.trim(), confirmation: true, operationId: v.operationId };
}

export function createConfirmedDealService({ provider = new FakeDealProvider() } = {}) {
  const operations = new Map();
  const idempotency = new Map();
  const inFlight = new Map();
  const ownedCompanies = (profileId) => {
    const ids = new Set(syntheticProfileCompanies[profileId] ?? []);
    return companies.filter((company) => ids.has(company.id));
  };
  const visible = (profileId, request) => ownedCompanies(profileId).some((c) => c.id === request.companyId && c.exhibitionIds.includes(request.exhibitionId)) && catalog.some((e) => e.id === request.exhibitionId);
  const response = (op, replayed = false) => ({ domainApiVersion: "1.0.0", operationId: op.operationId, status: op.status, companyId: op.request.companyId, exhibitionId: op.request.exhibitionId, ...(op.dealId ? { dealId: op.dealId } : {}), ...(op.linked ? { linkStatus: "linked" } : {}), replayed });

  async function create({ profileId, idempotencyKey, request }) {
    if (!visible(profileId, request)) return { status: 404, body: { error: "company_or_exhibition_not_found", operationId: request.operationId } };
    const key = keyFor(profileId, idempotencyKey);
    const existingId = idempotency.get(key);
    if (existingId) {
      const prior = operations.get(existingId);
      if (!same(prior.request, request)) return { status: 409, body: { error: "idempotency_conflict", operationId: request.operationId } };
      if (prior.status === "unknown") {
        const reconciled = await reconcileOne(prior);
        return reconciled.available
          ? { status: 200, body: response(prior, true) }
          : { status: 503, body: { error: "provider_unavailable", operationId: prior.operationId, status: prior.status } };
      }
      return { status: 200, body: response(prior, true) };
    }
    if (request.confirmation !== true) return { status: 400, body: { error: "explicit_confirmation_required", operationId: request.operationId } };
    const existingOp = operations.get(request.operationId);
    if (existingOp && existingOp.profileId !== profileId) return { status: 404, body: { error: "operation_not_found", operationId: request.operationId } };
    if (existingOp) return { status: 409, body: { error: "operation_id_conflict", operationId: request.operationId } };
    const pending = inFlight.get(key);
    if (pending) return pending;
    const op = { profileId, operationId: request.operationId, idempotencyKey, request, status: "pending", linked: false };
    operations.set(request.operationId, op); idempotency.set(key, request.operationId);
    const task = (async () => {
      try {
        const result = await provider.create({ operationId: op.operationId, request: op.request });
        op.status = result.status === "rejected" ? "rejected" : result.status === "created" && isDealId(result.dealId) ? "created" : "unknown";
        op.dealId = op.status === "created" ? result.dealId : undefined;
        return { status: op.status === "created" ? 201 : op.status === "rejected" ? 422 : 202, body: response(op) };
      } catch {
        op.status = "unknown";
        return { status: 202, body: response(op) };
      }
    })();
    inFlight.set(key, task);
    try { return await task; } finally { inFlight.delete(key); }
  }
  async function reconcileOne(op) {
    let result;
    try { result = await provider.reconcile(op.operationId); }
    catch { return { available: false }; }
    if (!result || typeof result !== "object") {
      op.status = "unknown"; op.dealId = undefined;
      return { available: true, status: "unknown" };
    }
    if (result.status === "created" && isDealId(result.dealId)) {
      op.status = "created"; op.dealId = result.dealId;
    } else if (result.status === "rejected") {
      op.status = "rejected"; op.dealId = undefined;
    } else {
      // An invalid or incomplete success is never evidence that a deal exists.
      op.status = "unknown"; op.dealId = undefined;
    }
    return { available: true, status: op.status };
  }
  function ownedOperation(profileId, operationId) {
    const op = operations.get(operationId);
    return op?.profileId === profileId ? op : null;
  }
  async function reconcile({ profileId, operationId }) {
    const op = ownedOperation(profileId, operationId);
    if (!op) return { status: 404, body: { error: "operation_not_found", operationId } };
    const result = await reconcileOne(op);
    if (!result.available) return { status: 503, body: { error: "provider_unavailable", operationId, status: op.status } };
    return { status: 200, body: response(op) };
  }
  async function repair({ profileId, operationId }) {
    const op = ownedOperation(profileId, operationId);
    if (!op) return { status: 404, body: { error: "operation_not_found", operationId } };
    if (op.status === "unknown" || op.status === "pending") {
      const result = await reconcileOne(op);
      if (!result.available) return { status: 503, body: { error: "provider_unavailable", operationId, status: op.status } };
    }
    if (op.status !== "created" || !op.dealId) return { status: 409, body: { error: "created_deal_required", operationId } };
    try { op.linked = (await provider.repairLink(operationId, op.dealId)) === true; }
    catch { return { status: 503, body: { error: "provider_unavailable", operationId, status: op.status } }; }
    return op.linked ? { status: 200, body: response(op) } : { status: 409, body: { error: "link_repair_failed", operationId } };
  }
  return { create, reconcile, repair };
}
