const BASE = "https://api.weeek.net/public/v1";
const safeId = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const safeProfile = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);

// The caller supplies a profile-bound token resolver. No token is read from an
// HTTP request, model arguments, process environment, or another profile.
export function createWeeekHttpTransport({ fetchImpl = globalThis.fetch, resolveToken,
  timeoutMs = 15000 } = {}) {
  if (typeof fetchImpl !== "function" || typeof resolveToken !== "function" ||
      !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000)
    throw new Error("weeek_transport_config_invalid");

  async function call(profileId, path, { method = "GET", body } = {}) {
    if (!safeProfile(profileId)) throw new Error("weeek_profile_invalid");
    const token = await resolveToken(profileId);
    if (typeof token !== "string" || !token || /[\r\n]/.test(token))
      throw new Error("weeek_token_unavailable");
    const response = await fetchImpl(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response?.ok) throw new Error("weeek_provider_unavailable");
    let data;
    try { data = await response.json(); } catch { throw new Error("weeek_response_invalid"); }
    if (!data || typeof data !== "object" || data.success !== true)
      throw new Error("weeek_response_invalid");
    return data;
  }

  return {
    async createDeal({ profileId, statusId, body }) {
      if (!safeId(statusId) || !body || typeof body.title !== "string" ||
          typeof body.description !== "string") throw new Error("weeek_create_invalid");
      const data = await call(profileId, `/crm/statuses/${encodeURIComponent(statusId)}/deals`,
        { method: "POST", body });
      if (!safeId(data.deal?.id)) throw new Error("weeek_response_invalid");
      return { success: true, deal: data.deal };
    },
    async listDeals({ profileId, statusId, limit, offset }) {
      if (!safeId(statusId) || !Number.isInteger(limit) || limit < 1 || limit > 100 ||
          !Number.isSafeInteger(offset) || offset < 0) throw new Error("weeek_list_invalid");
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      const data = await call(profileId,
        `/crm/statuses/${encodeURIComponent(statusId)}/deals?${params}`);
      if (!Array.isArray(data.deals) || typeof data.hasMoreDeals !== "boolean" ||
          data.deals.length > limit || data.deals.some((deal) => !safeId(deal?.id)))
        throw new Error("weeek_response_invalid");
      return { success: true, deals: data.deals, hasMoreDeals: data.hasMoreDeals };
    },
    async getDeal({ profileId, dealId }) {
      if (!safeId(dealId)) throw new Error("weeek_deal_id_invalid");
      const data = await call(profileId, `/crm/deals/${encodeURIComponent(dealId)}`);
      if (!data.deal || !safeId(data.deal.id) || data.deal.id !== dealId)
        throw new Error("weeek_response_invalid");
      return { success: true, deal: data.deal };
    }
  };
}
