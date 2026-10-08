const origin = process.env.CRM_MCP_SANDBOX_ORIGIN;
if (!origin) throw new Error("CRM_MCP_SANDBOX_ORIGIN must point to the isolated synthetic CRM Worker");
const base = new URL(origin);
if (base.protocol !== "https:" || !base.hostname.endsWith(".workers.dev"))
  throw new Error("CRM_MCP_SANDBOX_ORIGIN must be an HTTPS workers.dev URL");

async function json(path, init) {
  const response = await fetch(new URL(path, base), init);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

const headers = { accept: "application/json, text/event-stream", "content-type": "application/json",
  authorization: `Bearer ${"b".repeat(64)}`, "mcp-protocol-version": "2025-06-18" };
const send = body => json("/mcp", { method: "POST", headers, body: JSON.stringify(body) });
for (const protocolVersion of [null, "2025-03-26"]) {
  const requestHeaders = { accept: "application/json, text/event-stream", "content-type": "application/json" };
  if (protocolVersion) requestHeaders["mcp-protocol-version"] = protocolVersion;
  const rejected = await fetch(new URL("/mcp", base), { method: "POST", headers: requestHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", id: 90, method: "tools/list", params: {} }) });
  if (rejected.status !== 400) throw new Error(`unsupported protocol header accepted: ${protocolVersion}`);
}
const seed = await json("/__seed");
const initialized = await send({ jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "crm-public-sandbox-probe", version: "1" } } });
if (initialized.result?.protocolVersion !== "2025-06-18") throw new Error("MCP initialization contract mismatch");
const listed = await send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
const tool = listed.result?.tools?.find(item => item.name === "crm_exhibitions_catalog_search");
if (tool?._meta?.capabilityVersion !== "1.1.0") throw new Error("pinned CRM catalog tool missing");
const invoked = await send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: {
  name: tool.name, arguments: { exhibitionId: seed.v11ExhibitionId, limit: 5 },
  _meta: { capabilityVersion: tool._meta.capabilityVersion }
} });
const item = invoked.result?.structuredContent?.items?.[0];
if (invoked.result?.isError || item?.taxesPaidRub !== 1250000 || item?.employeeCount !== 42 ||
    item?.directorName !== "Synthetic Director 001") throw new Error("synthetic catalog tool output mismatch");

await json("/__cp-control?mode=deals_only");
let denied;
try {
  denied = await send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: {
    name: tool.name, arguments: { exhibitionId: seed.v11ExhibitionId },
    _meta: { capabilityVersion: tool._meta.capabilityVersion }
  } });
} finally {
  await json("/__cp-control?mode=active");
}
if (denied.error?.message !== "SCOPE_DENIED") throw new Error("scope denial did not fail closed");
const egress = await json("/__cp-count");
if (egress.foreignEgress !== 0) throw new Error("synthetic fixture attempted an external dependency call");

console.log(JSON.stringify({ result: "PASS", origin: base.origin, tool: tool.name,
  capabilityVersion: tool._meta.capabilityVersion, artifactVersion: invoked.result.structuredContent.artifactVersion,
  facts: { taxesPaidRub: item.taxesPaidRub, employeeCount: item.employeeCount, directorName: item.directorName },
  scopeDenial: denied.error.message, fixtureForeignEgress: egress.foreignEgress }));
