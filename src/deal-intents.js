import { randomUUID } from "node:crypto";
import { catalog, companies, syntheticProfileCompanies } from "./fixtures.js";

const uuid = () => randomUUID();
const intentKey = (profileId, idempotencyKey) => `${profileId}\u0000${idempotencyKey}`;
const sameRequest = (left, right) => left.companyId === right.companyId &&
  left.exhibitionId === right.exhibitionId && left.summary === right.summary;

export class FakeWeeekAdapter {
  #operations = new Map();

  async prepare({ profileId, idempotencyKey, request }) {
    const key = intentKey(profileId, idempotencyKey);
    if (!this.#operations.has(key)) {
      this.#operations.set(key, {
        reference: `fake-weeek-${uuid()}`,
        status: "accepted",
        request
      });
    }
    const operation = this.#operations.get(key);
    if (!sameRequest(operation.request, request)) {
      throw new Error("idempotency_conflict");
    }
    return { reference: operation.reference, status: operation.status };
  }

  async reconcile(reference) {
    const operation = [...this.#operations.values()].find((value) => value.reference === reference);
    return operation ? operation.status : "not_found";
  }
}

export function createDealIntentService({ adapter = new FakeWeeekAdapter() } = {}) {
  const intents = new Map();
  const byIdempotency = new Map();
  const inFlight = new Map();

  function visibleCompanies(profileId) {
    const profileCompanies = Object.hasOwn(syntheticProfileCompanies, profileId)
      ? syntheticProfileCompanies[profileId]
      : [];
    const visibleIds = new Set(profileCompanies);
    return companies.filter((company) => visibleIds.has(company.id));
  }

  async function create({ profileId, idempotencyKey, request }) {
    const company = visibleCompanies(profileId).find((item) => item.id === request.companyId);
    if (!company || !catalog.some((item) => item.id === request.exhibitionId) ||
        !company.exhibitionIds.includes(request.exhibitionId)) {
      return { status: 404, body: { error: "company_or_exhibition_not_found" } };
    }

    const key = intentKey(profileId, idempotencyKey);
    const priorId = byIdempotency.get(key);
    if (priorId) {
      const prior = intents.get(priorId);
      if (!sameRequest(prior.request, request)) {
        return { status: 409, body: { error: "idempotency_conflict" } };
      }
      return { status: 200, body: { ...prior.response, replayed: true } };
    }
    const pending = inFlight.get(key);
    if (pending) {
      const prior = await pending;
      if (!sameRequest(prior.request, request)) {
        return { status: 409, body: { error: "idempotency_conflict" } };
      }
      return { status: 200, body: { ...prior.response, replayed: true } };
    }

    const creation = (async () => {
      const id = `demo-intent-${uuid()}`;
      const operation = await adapter.prepare({ profileId, idempotencyKey, request });
      const response = {
        id,
        domainApiVersion: "1.0.0",
        companyId: request.companyId,
        exhibitionId: request.exhibitionId,
        summary: request.summary,
        status: "prepared",
        adapter: { name: "fake-weeek", reference: operation.reference, status: operation.status },
        createdAt: new Date().toISOString(),
        replayed: false
      };
      const record = { profileId, idempotencyKey, request, response };
      intents.set(id, record);
      byIdempotency.set(key, id);
      return record;
    })();
    inFlight.set(key, creation);
    try {
      const record = await creation;
      return { status: 201, body: record.response };
    } finally {
      inFlight.delete(key);
    }
  }

  async function get({ profileId, id }) {
    const intent = intents.get(id);
    if (!intent || intent.profileId !== profileId) {
      return { status: 404, body: { error: "deal_intent_not_found" } };
    }
    // Reconciliation reads fake adapter state; it never submits or retries a command.
    const adapterStatus = await adapter.reconcile(intent.response.adapter.reference);
    return {
      status: 200,
      body: { ...intent.response, adapter: { ...intent.response.adapter, status: adapterStatus } }
    };
  }

  return { create, get, visibleCompanies };
}

export function isDealIntentRequest(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every((key) => ["companyId", "exhibitionId", "summary"].includes(key)) &&
    typeof value.companyId === "string" && /^demo-company-[0-9]{3}$/.test(value.companyId) &&
    typeof value.exhibitionId === "string" && /^demo-expo-[0-9]{3}$/.test(value.exhibitionId) &&
    typeof value.summary === "string" && value.summary.trim().length > 0 && [...value.summary].length <= 500;
}
