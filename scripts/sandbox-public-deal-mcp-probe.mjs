#!/usr/bin/env node
// Calls the sandbox-published CRM deal MCP tools over HTTPS, then checks the
// canonical D1/Weeek fixture state through key-protected diagnostics.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const origin = process.env.CRM_MCP_SANDBOX_ORIGIN?.replace(/\/$/, "");
const debugKey = process.env.CRM_CONNECTED_SANDBOX_TEST_KEY;
if (!origin) throw new Error("CRM_MCP_SANDBOX_ORIGIN must point to the isolated synthetic CRM Worker");
if (!debugKey || debugKey.length < 32)
  throw new Error("CRM_CONNECTED_SANDBOX_TEST_KEY must be supplied from the sandbox secret store");
const base = new URL(origin);
if (base.protocol !== "https:" || !base.hostname.endsWith(".workers.dev"))
  throw new Error("CRM_MCP_SANDBOX_ORIGIN must be an HTTPS workers.dev URL");

const headers = { accept: "application/json, text/event-stream", "content-type": "application/json",
  authorization: `Bearer ${"b".repeat(64)}`, "mcp-protocol-version": "2025-06-18" };
const debugHeaders = { "x-crm-sandbox-test-key": debugKey };
let requestId = 0;
async function json(path, init = {}) {
  const response = await fetch(new URL(path, base), { redirect: "manual", ...init });
  const body = await response.json().catch(() => null);
  return { response, body };
}
async function debug(path, init = {}) {
  const result = await json(path, { ...init, headers: { ...init.headers, ...debugHeaders } });
  assert.equal(result.response.ok, true, `${path} returned ${result.response.status}`);
  return result.body;
}
async function mcp(method, params = {}, { authorization = headers.authorization } = {}) {
  const requestHeaders = { ...headers };
  if (authorization) requestHeaders.authorization = authorization;
  else delete requestHeaders.authorization;
  const result = await json("/mcp", { method: "POST", headers: requestHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }) });
  assert.equal(result.response.status, 200, `MCP ${method} returned ${result.response.status}`);
  return result.body;
}
async function callTool(name, args, version = "1.0.0", options = {}) {
  return mcp("tools/call", { name, arguments: args, _meta: { capabilityVersion: version } }, options);
}
async function setMode(mode) { await debug(`/__cp-control?mode=${encodeURIComponent(mode)}`); }

try {
  const initialized = await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {},
    clientInfo: { name: "crm-s04-public-mcp-probe", version: "1" } });
  assert.equal(initialized.result?.protocolVersion, "2025-06-18");
  const listed = await mcp("tools/list");
  const names = listed.result?.tools?.map((tool) => tool.name);
  assert.deepEqual(names, ["crm_exhibitions_catalog_search", "crm_deal_prepare_from_participant",
    "crm_deal_create_from_participant", "crm_deal_get_operation", "crm_deal_reconcile_operation"]);
  const dealTools = listed.result.tools.slice(1);
  assert.ok(dealTools.every((tool) => tool._meta.capabilityVersion === "1.0.0"));

  const seed = randomBytes(6).toString("hex");
  const login = await json(`/__sandbox-login?view=deal&seed=${seed}`, { headers: debugHeaders });
  assert.equal(login.response.status, 303);
  const participant = new URL(login.response.headers.get("location"), base);
  const match = participant.pathname.match(/^\/catalogs\/(build-[a-f0-9]{24})\/participants\/(co-[a-f0-9]{20})\/deal$/);
  assert.ok(match, participant.pathname);
  const [, buildId, companyId] = match;
  const args = { buildId, companyId, exhibitionId: "demo-expo-001", title: `Synthetic MCP deal ${seed}`,
    companyInn: "0000000001", contactName: "Synthetic Contact", dealComment: "Synthetic approval and recovery probe." };

  const unauthenticated = await callTool("crm_deal_prepare_from_participant", args, "1.0.0", { authorization: null });
  assert.equal(unauthenticated.error?.message, "AUTH_CONTEXT_UNAVAILABLE");
  await setMode("deals_only");
  const wrongScope = await callTool("crm_deal_prepare_from_participant", args);
  assert.equal(wrongScope.error?.message, "SCOPE_DENIED");
  await setMode("profile_B");
  const wrongProfile = await callTool("crm_deal_prepare_from_participant", args);
  assert.equal(wrongProfile.error?.message, "NOT_FOUND");
  await setMode("deal_create");

  const preparedCall = await callTool("crm_deal_prepare_from_participant", args);
  assert.equal(preparedCall.result?.isError, false, JSON.stringify(preparedCall.error));
  const prepared = preparedCall.result.structuredContent;
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.details.companyId, companyId);

  const beforeApproval = await debug("/__cp-count");
  const approvalCall = await callTool("crm_deal_create_from_participant",
    { reviewId: prepared.reviewId, revision: prepared.revision });
  const approval = approvalCall.result;
  assert.equal(approval.isError, false);
  assert.equal(approval._meta?.outcome, "pending");
  assert.equal(approval.structuredContent.error, "human_approval_required");
  assert.match(approval.structuredContent.approvalUrl,
    /^https:\/\/cp\.example\.invalid\/v1\/connected-app-approvals\/review\?intent=/);
  assert.equal((await debug("/__cp-count")).weeekCreatePosts, beforeApproval.weeekCreatePosts,
    "preparation and missing approval must not create a deal");

  await debug("/__sandbox-approve");
  const accepted = await callTool("crm_deal_create_from_participant",
    { reviewId: prepared.reviewId, revision: prepared.revision });
  assert.equal(accepted.result?.isError, false);
  assert.equal(accepted.result?._meta?.outcome, "pending");
  assert.equal(accepted.result?.structuredContent?.status, "unknown",
    "the lost provider reply is reported as unknown, not success");
  const operationId = prepared.operationId;

  const reconciled = await callTool("crm_deal_reconcile_operation", { operationId });
  assert.equal(reconciled.result?.structuredContent?.status, "created");
  assert.equal(reconciled.result?.structuredContent?.linkStatus, "linked");
  const replay = await callTool("crm_deal_create_from_participant",
    { reviewId: prepared.reviewId, revision: prepared.revision });
  assert.equal(replay.result?.structuredContent?.dealId, reconciled.result.structuredContent.dealId);
  const readback = await callTool("crm_deal_get_operation", { operationId });
  assert.equal(readback.result?.structuredContent?.dealId, reconciled.result.structuredContent.dealId);

  const counts = await debug("/__cp-count");
  assert.equal(counts.weeekCreatePosts, 1, "replay and reconciliation must not create another deal");
  assert.equal(counts.foreignEgress, 0, "synthetic CP and Weeek fixtures are the only egress targets");
  console.log(JSON.stringify({ result: "PASS", origin: base.origin, tools: names,
    profileScopeDenial: wrongScope.error.message, wrongProfile: wrongProfile.error.message,
    review: prepared.status, noCreateBeforeApproval: true, approvalPending: true,
    lostReply: "unknown", reconciliation: "created_and_linked", providerCreatePosts: counts.weeekCreatePosts,
    fixtureForeignEgress: counts.foreignEgress }));
} finally {
  await setMode("active").catch(() => {});
}
