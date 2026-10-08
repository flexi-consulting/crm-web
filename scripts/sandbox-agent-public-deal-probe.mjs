#!/usr/bin/env node
// Agent Runner MCP -> stable public CRM sandbox -> connected BFF and deal-review handlers.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(new URL("..", import.meta.url).pathname);
const runnerRoot = resolve(process.env.AI_AGENT_RUNNER_ROOT ?? "");
const publicOrigin = (process.env.CRM_SANDBOX_PUBLIC_ORIGIN ?? "").replace(/\/$/, "");
const diagnosticsOrigin = (process.env.CRM_SANDBOX_DIAGNOSTICS_ORIGIN ?? "").replace(/\/$/, "");
if (!process.env.AI_AGENT_RUNNER_ROOT) throw new Error("AI_AGENT_RUNNER_ROOT must point to an isolated Agent Runner checkout");
if (!publicOrigin) throw new Error("CRM_SANDBOX_PUBLIC_ORIGIN must point to the stable synthetic sandbox ingress");
if (!diagnosticsOrigin) throw new Error("CRM_SANDBOX_DIAGNOSTICS_ORIGIN must point to the local synthetic Worker loopback only");
const origin = new URL(publicOrigin);
assert.equal(origin.protocol, "https:");
assert.match(origin.hostname, /^[a-z0-9-]+\.skillset-apply\.workers\.dev$/);
const diagnosticsUrl = new URL(diagnosticsOrigin);
assert.equal(diagnosticsUrl.protocol, "http:");
assert.ok(["127.0.0.1", "localhost"].includes(diagnosticsUrl.hostname),
  "synthetic database diagnostics must remain on loopback");
assert.equal(diagnosticsUrl.username, "");
assert.equal(diagnosticsUrl.password, "");
assert.equal(diagnosticsUrl.search, "");
assert.equal(diagnosticsUrl.hash, "");

const profileId = "profile_A";
const prepareTool = "crm_deal_prepare_from_participant";
const confirmTool = "crm_deal_create_from_participant";
const reconcileTool = "crm_deal_reconcile_operation";
const toolNames = [prepareTool, confirmTool, reconcileTool];
const serverId = "crm-web-s04-sandbox";
const bindingRef = `cred:crm-public-deal-${randomBytes(6).toString("hex")}`;
const workDir = mkdtempSync(join(tmpdir(), "crm-agent-public-deal-"));
const cookieFor = response => response.headers.getSetCookie().map(value => value.split(";", 1)[0])
  .find(value => value.startsWith("__Host-crm-connected-session="));
const request = (path, options = {}) => fetch(`${publicOrigin}${path}`, { redirect: "manual", ...options });
const diagnostics = path => fetch(`${diagnosticsOrigin}${path}`, { redirect: "manual" });
const evidenceFor = runRoot => readFileSync(join(runRoot, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse)
  .filter(event => event.type === "log" && event.payload?.stream === "stdout" &&
    event.payload.message.startsWith("mcp-evidence: "))
  .map(event => JSON.parse(event.payload.message.slice("mcp-evidence: ".length)));
let runner;

try {
  const login = await request(`/__sandbox-login?view=deal&seed=${randomBytes(6).toString("hex")}`);
  assert.equal(login.status, 303);
  const session = cookieFor(login);
  assert.ok(session, "synthetic deal entry should issue a profile-bound session");
  const dealUrl = new URL(login.headers.get("location"), publicOrigin);
  const match = dealUrl.pathname.match(/^\/catalogs\/(build-[a-f0-9]{24})\/participants\/(co-[a-f0-9]{20})\/deal$/);
  assert.ok(match, `unexpected sandbox deal entry path: ${dealUrl.pathname}`);
  const [, buildId, companyId] = match;
  const dealPage = await request(dealUrl.pathname, { headers: { cookie: session } });
  assert.equal(dealPage.status, 200);
  const html = await dealPage.text();
  assert.match(html, /Подготовить сделку/);
  const csrf = html.match(/name="_csrf" value="([a-f0-9]{64})"/)?.[1];
  const exhibitionId = html.match(/name="exhibitionId" value="([a-z0-9-]+)"/)?.[1];
  const title = html.match(/name="title" maxlength="160" required value="([^"]+)"/)?.[1];
  const companyInn = html.match(/name="companyInn" maxlength="20" required value="([^"]*)"/)?.[1] || "0000000001";
  assert.ok(csrf && exhibitionId && title && companyInn, "deal form must render its CSRF and trusted source fields");

  const [{ Runner }, { CapabilityRegistry }, { FakeEngine }, { validateRunSpec }] = await Promise.all([
    import(pathToFileURL(join(runnerRoot, "dist/runner/runner.js")).href),
    import(pathToFileURL(join(runnerRoot, "dist/mcp/capabilities.js")).href),
    import(pathToFileURL(join(runnerRoot, "dist/adapters/engine/fake-engine.js")).href),
    import(pathToFileURL(join(runnerRoot, "dist/contracts/run-spec.js")).href)
  ]);
  const registry = new CapabilityRegistry();
  for (const name of toolNames) registry.register({ capabilityId: name, capabilityVersion: 1,
    requiredScopes: ["crm.deals.create"], requiredArguments: name === prepareTool
      ? ["buildId", "companyId", "exhibitionId", "title", "companyInn", "contactName", "dealComment"]
      : name === confirmTool ? ["reviewId", "revision"] : ["operationId"],
    effect: name === reconcileTool ? "read" : "write",
    description: "Profile-bound reviewed deal workflow through the connected CRM app",
    async invoke(invocation, context) {
      if (invocation.caller.profileId !== profileId || context.bindingValue !== session)
        return { kind: "blocked", reason: "synthetic profile/session binding mismatch" };
      const args = invocation.arguments;
      const path = name === prepareTool ? "/api/v1/deal-reviews"
        : name === confirmTool ? `/api/v1/deal-reviews/${encodeURIComponent(String(args.reviewId))}/confirm`
          : `/api/v1/deal-operations/${encodeURIComponent(String(args.operationId))}/reconcile`;
      const response = await request(path, { method: "POST",
        headers: { cookie: context.bindingValue, origin: "https://crm.example.invalid",
          "x-csrf-token": csrf, "content-type": "application/json" },
        body: JSON.stringify(name === prepareTool ? args : name === confirmTool ? { revision: args.revision } : {}) });
      let result;
      try { result = await response.json(); } catch { return { kind: "technical_error", code: "CRM_INVALID_RESPONSE" }; }
      if (name === confirmTool && response.status === 202)
        return { kind: "blocked", reason: "PROVIDER_OUTCOME_UNKNOWN" };
      if (!response.ok) return { kind: "blocked", reason: String(result.error ?? `CRM_HTTP_${response.status}`) };
      if (name === confirmTool && result.status === "unknown")
        return { kind: "blocked", reason: "PROVIDER_OUTCOME_UNKNOWN" };
      const outcome = { kind: "completed", result };
      if (name !== reconcileTool) outcome.effectReceipt = { receiptId: name === prepareTool
          ? result.reviewId : result.dealId ?? result.operationId,
        capabilityId: name, capabilityVersion: 1, operationId: invocation.caller.operationId,
        bindingRef: invocation.binding.ref, at: new Date().toISOString(),
        ...(name === confirmTool && result.dealId ? { externalRef: result.dealId } : {}) };
      return outcome;
    } });

  const facade = join(root, "fixtures/s04-runner-mcp.mjs");
  const allowedEnv = ["PATH", "CRM_AGENT_RUNNER_ROOT", "MCP_ALLOWED_TOOLS"];
  process.env.CRM_AGENT_RUNNER_ROOT = runnerRoot;
  process.env.MCP_ALLOWED_TOOLS = toolNames.join(",");
  runner = new Runner({ rootDir: workDir, adapters: { fake: new FakeEngine("mcp-tools") },
    host: { region: "sandbox-eu", environment: "sandbox" }, cancelGraceMs: 500,
    capabilities: registry, bindingResolver: ref => ref === bindingRef ? session : null });
  let runIndex = 0;
  const runAgent = async (name, args, { expectedOutcome = "succeeded" } = {}) => {
    const cwd = join(workDir, `agent-workspace-${++runIndex}`);
    const rawSpec = { contractVersion: 1, jobId: `job-${randomBytes(4).toString("hex")}`,
      runId: `run-${randomBytes(6).toString("hex")}`, operationId: `op-${randomBytes(6).toString("hex")}`,
      userTaskId: `task-${randomBytes(6).toString("hex")}`, profileId,
      conversationId: `conv-${randomBytes(6).toString("hex")}`, ownerGeneration: 1,
      engine: { name: "fake", adapterVersion: "1" }, cwd, envAllowlist: [], limits: { timeoutMs: 60_000 },
      credentialBindings: [{ ref: bindingRef, scope: "crm.deals.create" }],
      mcp: { servers: [{ serverId, transport: "stdio", command: process.execPath,
        args: [facade], envAllowlist: allowedEnv, bindingRef, allowedTools: toolNames }] },
      input: { inlinePrompt: JSON.stringify({ calls: [{ tool: name, arguments: args }], denied: [] }) } };
    const validated = validateRunSpec(rawSpec);
    assert.equal(validated.ok, true, validated.errors?.join("; "));
    const receipt = runner.start(validated.value);
    const outcome = await runner.waitFor(receipt.runId, 30_000);
    const runRoot = join(workDir, "runs", receipt.runId);
    const events = readFileSync(join(runRoot, "events.jsonl"), "utf8");
    assert.equal(outcome.outcome, expectedOutcome, `${JSON.stringify(outcome)}\n${events}`);
    assert.equal(existsSync(cwd), false);
    const evidence = evidenceFor(runRoot);
    const listed = evidence.find(item => item.step === "tools_list");
    const call = evidence.find(item => item.step === "tool_call");
    assert.ok(toolNames.every(tool => listed?.tools.some(item => item.name === tool)));
    assert.ok(call, `MCP tool call evidence missing for ${name}`);
    assert.equal(call.tool, name);
    assert.equal(call.ok, expectedOutcome === "succeeded", JSON.stringify(call));
    return { call, runRoot };
  };

  const draftRun = await runAgent(prepareTool, { buildId, companyId, exhibitionId, title, companyInn,
    contactName: "Synthetic Contact", dealComment: "Discuss catalog participation." });
  const prepared = draftRun.call.result;
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.details.companyId, companyId);
  assert.equal(prepared.details.title, title);
  assert.equal(prepared.details.dealComment, "Discuss catalog participation.");
  const review = await request(`/api/v1/deal-reviews/${encodeURIComponent(prepared.reviewId)}`,
    { headers: { cookie: session } });
  assert.equal(review.status, 200);
  const reviewData = await review.json();
  assert.deepEqual(reviewData.details, prepared.details);
  assert.equal(reviewData.status, "prepared");

  const beforeApproval = await diagnostics("/__cp-count");
  assert.equal(beforeApproval.status, 200);
  const initialCreatePosts = (await beforeApproval.json()).weeekCreatePosts;
  assert.ok(Number.isSafeInteger(initialCreatePosts));
  const noWriteBeforeApproval = await diagnostics("/__cp-count");
  assert.equal((await noWriteBeforeApproval.json()).weeekCreatePosts, initialCreatePosts,
    "neither a prepared review nor an unapproved command may create a deal");

  const approvalPrompt = await request("/deal-workflow/confirm", { method: "POST",
    headers: { cookie: session, origin: publicOrigin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: csrf, reviewId: prepared.reviewId, revision: prepared.revision }) });
  assert.equal(approvalPrompt.status, 409);
  assert.match(await approvalPrompt.text(), /__sandbox-approve/);
  const afterRejectedConfirmation = await diagnostics("/__cp-count");
  assert.equal((await afterRejectedConfirmation.json()).weeekCreatePosts, initialCreatePosts,
    "a rejected or unapproved confirmation must not reach the provider");
  const approvalPage = await request("/__sandbox-approve", { headers: { cookie: session } });
  assert.equal(approvalPage.status, 200);
  assert.match(await approvalPage.text(), /Синтетическое подтверждение/);

  const operationId = prepared.operationId;
  assert.ok(operationId);
  const unverifiedCreate = await runAgent(confirmTool,
    { reviewId: prepared.reviewId, revision: prepared.revision }, { expectedOutcome: "failed" });
  assert.equal(unverifiedCreate.call.ok, false,
    "lost provider acknowledgement must remain an incomplete MCP write");
  assert.match(unverifiedCreate.call.error?.message ?? "", /PROVIDER_OUTCOME_UNKNOWN/,
    JSON.stringify(unverifiedCreate.call));
  const afterProviderTimeout = await diagnostics("/__cp-count");
  assert.equal(afterProviderTimeout.status, 200);
  assert.equal((await afterProviderTimeout.json()).weeekCreatePosts, initialCreatePosts + 1,
    "the provider accepted exactly one create despite the lost response");
  const reconcileRun = await runAgent(reconcileTool, { operationId });
  assert.equal(reconcileRun.call.result.status, "created", JSON.stringify(reconcileRun.call.result));
  const operationResponse = await request(`/api/v1/deal-operations/${encodeURIComponent(operationId)}`,
    { headers: { cookie: session } });
  assert.equal(operationResponse.status, 200);
  const operation = await operationResponse.json();
  assert.equal(operation.status, "created");
  assert.equal(operation.linkStatus, "linked");
  const afterReconcile = await diagnostics("/__cp-count");
  assert.equal(afterReconcile.status, 200);
  assert.equal((await afterReconcile.json()).weeekCreatePosts, initialCreatePosts + 1,
    "reconciliation must not retry the provider create");
  const persisted = [draftRun, unverifiedCreate, reconcileRun].flatMap(({ runRoot }) => ["events.jsonl", "state.json", "result.json"]
    .map(name => readFileSync(join(runRoot, name), "utf8")));
  assert.equal(persisted.some(value => value.includes(session)), false,
    "connected-session cookie must not be persisted in Agent Runner artifacts");
  process.stdout.write(`${JSON.stringify({ outcome: "pass", runner: "FakeEngine over Agent Runner MCP bridge",
    siteTransport: "stable Workers.dev -> Quick Tunnel -> synthetic CRM connected app handlers",
    profileId, tools: toolNames, reviewStatus: reviewData.status,
    publicDealPage: "rendered", reviewReadBack: "matched MCP result",
    approval: "synthetic Control Plane stub", finalDeal: operation.dealId,
    operation: operation.status, providerTimeoutReconciled: true, sessionBindingPersisted: false })}\n`);
} finally {
  runner?.dispose();
  rmSync(workDir, { recursive: true, force: true });
}
