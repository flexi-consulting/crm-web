import builtDescriptor from "../capabilities/s02-built-participants.v1.json" with { type: "json" };
import preleadDescriptor from "../capabilities/s03-built-preleads.v1.json" with { type: "json" };
import dealDescriptor from "../capabilities/s04-deals.v1.json" with { type: "json" };
import builtInput from "../schemas/built-participants-input.schema.json" with { type: "json" };
import timelineInput from "../schemas/s03-built-timeline-input.schema.json" with { type: "json" };
import noteInput from "../schemas/s03-built-note-input.schema.json" with { type: "json" };
import rejectInput from "../schemas/s03-built-reject-input.schema.json" with { type: "json" };
import undoInput from "../schemas/s03-built-undo-input.schema.json" with { type: "json" };
import reviewInput from "../schemas/s04-review-input.schema.json" with { type: "json" };
import confirmInput from "../schemas/s04-create-input.schema.json" with { type: "json" };
import operationInput from "../schemas/s04-operation-input.schema.json" with { type: "json" };
import { normalizeDealReviewRequest } from "./deal-reviews.js";

const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, allowed) => object(value) && Object.keys(value).every((key) => allowed.includes(key));
const validBuilt = (args) => exactKeys(args, ["buildId", "q", "classification"]) &&
  /^build-[a-f0-9]{24}$/.test(args.buildId ?? "") &&
  (args.q === undefined || typeof args.q === "string" && [...args.q].length <= 120) &&
  (args.classification === undefined || ["target", "near_target", "not_target"].includes(args.classification));
const validTimeline = (args) => exactKeys(args, ["preleadId"]) && /^built-prelead-[a-f0-9]{24}$/.test(args.preleadId ?? "");
const validNote = (args) => exactKeys(args, ["preleadId", "operationId", "noteText"]) &&
  /^built-prelead-[a-f0-9]{24}$/.test(args.preleadId ?? "") && /^op-[0-9a-f-]{36}$/.test(args.operationId ?? "") &&
  typeof args.noteText === "string" && args.noteText.trim().length > 0 && [...args.noteText.trim()].length <= 1000;
const validReject = (args) => exactKeys(args, ["preleadId", "operationId", "reason"]) &&
  /^built-prelead-[a-f0-9]{24}$/.test(args.preleadId ?? "") && /^op-[0-9a-f-]{36}$/.test(args.operationId ?? "") &&
  typeof args.reason === "string" && args.reason.trim().length > 0 && [...args.reason.trim()].length <= 300;
const validUndo = (args) => exactKeys(args, ["preleadId", "operationId", "targetEventId"]) &&
  /^built-prelead-[a-f0-9]{24}$/.test(args.preleadId ?? "") && /^op-[0-9a-f-]{36}$/.test(args.operationId ?? "") &&
  /^evt-[0-9a-f-]{36}$/.test(args.targetEventId ?? "");
const validConfirm = (args) => exactKeys(args, ["reviewId", "revision"]) &&
  /^review-[0-9a-f-]{36}$/.test(args.reviewId ?? "") && /^[a-f0-9]{64}$/.test(args.revision ?? "");
const validOperation = (args) => exactKeys(args, ["operationId"]) && /^op-[0-9a-f-]{36}$/.test(args.operationId ?? "");
const tools = [
  { name: builtDescriptor.mcpTool.name, operation: "built", scope: builtDescriptor.requiredScopes[0], inputSchema: builtInput,
    _meta: { capabilityId: builtDescriptor.capabilityId, capabilityVersion: builtDescriptor.version } },
  ...preleadDescriptor.tools.map((tool) => ({ ...tool,
    inputSchema: tool.operation === "getTimeline" ? timelineInput : tool.operation === "addNote" ? noteInput
      : tool.operation === "reject" ? rejectInput : undoInput,
    _meta: { capabilityId: preleadDescriptor.capabilityId, capabilityVersion: preleadDescriptor.version } })),
  ...dealDescriptor.tools.map((tool) => ({ ...tool,
    inputSchema: tool.operation === "prepare" ? reviewInput : tool.operation === "confirm" ? confirmInput : operationInput,
    _meta: { capabilityId: dealDescriptor.capabilityId, capabilityVersion: dealDescriptor.version } }))
];

// Worker-safe, test-only JSON-RPC adapter. Inputs are checked before calling the shared D1 domain methods;
// contract tests compile the declared output schemas in Node, where Ajv code generation is allowed.
export function createBuiltD1OfflineMcp({ domain, resolveTrustedProfile, resolveTrustedReviewReceipt }) {
  let negotiated = false, initialized = false;
  return {
    async receive(raw) {
      let message;
      try { message = typeof raw === "string" ? JSON.parse(raw) : raw; }
      catch { return JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
      const reply = (part) => JSON.stringify({ jsonrpc: "2.0", id: message?.id ?? null, ...part });
      if (message?.jsonrpc !== "2.0") return reply({ error: { code: -32600, message: "Invalid Request" } });
      if (message.method === "initialize") {
        if (message.params?.protocolVersion !== "2025-06-18") return reply({ error: { code: -32002, message: "CAPABILITY_VERSION_MISMATCH" } });
        negotiated = true;
        return reply({ result: { protocolVersion: "2025-06-18", capabilities: { tools: {} },
          serverInfo: { name: "crm-built-d1-offline", version: "1.0.0" } } });
      }
      if (message.method === "notifications/initialized") { if (negotiated) initialized = true; return null; }
      if (!initialized) return reply({ error: { code: -32000, message: "NOT_INITIALIZED" } });
      if (message.method === "tools/list") return reply({ result: { tools: tools.map(({ operation: _operation, scope: _scope, ...tool }) => tool) } });
      if (message.method !== "tools/call") return reply({ error: { code: -32601, message: "Method not found" } });
      const tool = tools.find((item) => item.name === message.params?.name);
      if (!tool) return reply({ error: { code: -32602, message: "UNKNOWN_TOOL" } });
      if (message.params?._meta?.capabilityVersion !== tool._meta.capabilityVersion)
        return reply({ error: { code: -32002, message: "CAPABILITY_VERSION_MISMATCH" } });
      const args = message.params.arguments;
      const valid = tool.operation === "built" ? validBuilt(args)
        : tool.operation === "getTimeline" ? validTimeline(args)
        : tool.operation === "addNote" ? validNote(args)
        : tool.operation === "reject" ? validReject(args)
        : tool.operation === "undoRejection" ? validUndo(args)
        : tool.operation === "prepare" ? Boolean(normalizeDealReviewRequest(args))
        : tool.operation === "confirm" ? validConfirm(args) : validOperation(args);
      if (!valid) return reply({ error: { code: -32602, message: "INVALID_ARGUMENTS" } });
      let context;
      try { context = await resolveTrustedProfile?.(); } catch {}
      if (!context?.profileId || !Array.isArray(context.scopes)) return reply({ error: { code: -32001, message: "AUTH_CONTEXT_UNAVAILABLE" } });
      if (!context.scopes.includes(tool.scope)) return reply({ error: { code: -32003, message: "SCOPE_DENIED" } });
      let result;
      if (tool.operation === "built") result = await domain.catalogBuilds.readParticipants({ profileRef: context.profileId,
        buildId: args.buildId, query: args.q ?? "", classification: args.classification ?? null });
      else if (tool.operation === "getTimeline") result = await domain.preleads.getTimeline({ profileId: context.profileId,
        preleadId: args.preleadId });
      else if (tool.operation === "addNote") result = await domain.preleads.addNote({ profileId: context.profileId,
        preleadId: args.preleadId, request: { type: "note_added", operationId: args.operationId, noteText: args.noteText } });
      else if (tool.operation === "reject") result = await domain.preleads.addEvent({ profileId: context.profileId,
        preleadId: args.preleadId, request: { type: "rejection_added", operationId: args.operationId, reason: args.reason } });
      else if (tool.operation === "undoRejection") result = await domain.preleads.addEvent({ profileId: context.profileId,
        preleadId: args.preleadId, request: { type: "rejection_undone", operationId: args.operationId,
          targetEventId: args.targetEventId } });
      else if (tool.operation === "prepare") result = await domain.reviewService.prepare({ profileId: context.profileId, request: args });
      else if (tool.operation === "confirm") {
        let trustedReceipt;
        try { trustedReceipt = await resolveTrustedReviewReceipt?.({ profileId: context.profileId,
          reviewId: args.reviewId, revision: args.revision }); } catch {}
        result = await domain.reviewService.confirm({ profileId: context.profileId,
          reviewId: args.reviewId, revision: args.revision, trustedReceipt });
      } else result = await domain.dealService[tool.operation]({ profileId: context.profileId, operationId: args.operationId });
      if (result.status >= 400) return reply({ error: { code: -32004, message: result.body.error, data: result.body } });
      return reply({ result: { content: [{ type: "text", text: JSON.stringify(result.body) }],
        structuredContent: result.body, isError: false } });
    }
  };
}
