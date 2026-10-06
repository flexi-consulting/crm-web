import { createHash } from "node:crypto";

// Contract-only provider: transport is injected. This module has no token,
// fetch, endpoint binding, or production registration.
const markerFor = ({ profileId, operationId, requestHash }) => {
  if (!/^op-[0-9a-f-]{36}$/.test(operationId ?? "") ||
      !/^[0-9a-f]{64}$/.test(requestHash ?? "") || !profileId)
    throw new Error("invalid_operation_correlation");
  const digest = createHash("sha256").update(JSON.stringify([profileId, operationId, requestHash])).digest("hex");
  return `[crm-web-s04:${operationId}:${digest}]`;
};
const clean = (value) => typeof value === "string" ? value.trim() : "";
const descriptionFor = (request, marker) => [
  clean(request.dealComment),
  `Source: ${clean(request.source)}`,
  `Type: ${clean(request.dealType)}`,
  `INN: ${clean(request.companyInn)}`,
  `Contact: ${clean(request.contactName)}`,
  marker
].join("\n");
const validDeal = (deal, expected) => deal && typeof deal.id === "string" && deal.id.length > 0 &&
  deal.title === expected.title && deal.description === expected.description &&
  deal.description.split(expected.marker).length === 2;

export function createWeeekCorrelationProvider({ transport, resolveStatusIds, pageSize = 100,
  maxPages = 100 } = {}) {
  if (!transport?.createDeal || !transport?.listDeals || !transport?.getDeal ||
      typeof resolveStatusIds !== "function") throw new Error("provider_contract_required");
  async function verifyDeal(dealId, expected) {
    const result = await transport.getDeal({ profileId: expected.profileId, dealId: String(dealId) });
    return result?.success === true && validDeal(result.deal, expected) &&
      result.deal.id === String(dealId) ? result.deal : null;
  }
  function expectedFor({ profileId, operationId, request, requestHash }) {
    const marker = markerFor({ profileId, operationId, requestHash });
    if (!request || !clean(request.statusId) || !clean(request.title) ||
        !clean(request.source) || !clean(request.dealType) ||
        !clean(request.companyInn) || !clean(request.contactName) ||
        !clean(request.dealComment)) throw new Error("invalid_reviewed_deal_fields");
    return { profileId, title: request.title, description: descriptionFor(request, marker), marker };
  }
  async function create(input) {
    const expected = expectedFor(input);
    // Weeek documents no idempotency key. The D1 caller must reserve before this POST.
    const response = await transport.createDeal({ profileId: input.profileId, statusId: input.request.statusId,
      body: { title: expected.title, description: expected.description } });
    if (response?.success !== true || !response.deal?.id) return { status: "unknown" };
    const verified = await verifyDeal(response.deal.id, expected);
    return verified ? { status: "created", dealId: verified.id, providerRef: expected.marker }
      : { status: "unknown" };
  }
  async function reconcile(input) {
    let expected;
    try { expected = expectedFor(input); } catch { return { status: "unknown", reason: "invalid_correlation" }; }
    let statusIds;
    try { statusIds = await resolveStatusIds(input.profileId); } catch { return { status: "unknown", reason: "status_scope_unavailable" }; }
    if (!Array.isArray(statusIds) || statusIds.length === 0 ||
        statusIds.some((id) => !clean(id)) || new Set(statusIds).size !== statusIds.length ||
        !statusIds.includes(input.request.statusId))
      return { status: "unknown", reason: "status_scope_incomplete" };
    const matchedIds = new Set();
    try {
      for (const statusId of statusIds) {
        let complete = false;
        for (let page = 0; page < maxPages; page++) {
          // Scan the whole configured status set. The API's `search` behavior is
          // unspecified, so it cannot establish uniqueness or absence.
          const response = await transport.listDeals({ profileId: input.profileId, statusId, limit: pageSize,
            offset: page * pageSize });
          if (response?.success !== true || !Array.isArray(response.deals) ||
              typeof response.hasMoreDeals !== "boolean")
            return { status: "unknown", reason: "incomplete_scan" };
          for (const deal of response.deals) {
            if (typeof deal?.description === "string" && deal.description.includes(expected.marker)) {
              if (!validDeal(deal, expected)) return { status: "unknown", reason: "incompatible_match" };
              matchedIds.add(deal.id);
              if (matchedIds.size > 1) return { status: "unknown", reason: "multiple_matches" };
            }
          }
          if (response.hasMoreDeals !== true) { complete = true; break; }
        }
        if (!complete) return { status: "unknown", reason: "incomplete_scan" };
      }
      if (matchedIds.size !== 1) return { status: "unknown", reason: "marker_not_found" };
      const dealId = [...matchedIds][0];
      const verified = await verifyDeal(dealId, expected);
      return verified ? { status: "created", dealId: verified.id, providerRef: expected.marker }
        : { status: "unknown", reason: "detail_verification_failed" };
    } catch { return { status: "unknown", reason: "provider_unavailable" }; }
  }
  return { create, reconcile };
}
