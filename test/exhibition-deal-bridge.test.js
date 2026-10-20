import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  buildExhibitionDealRequestBody,
  formatExhibitionDealDryRun,
  formatExhibitionDealResult,
  normalizeExhibitionDealRequest,
  parseExhibitionDealStart
} from "../src/exhibition-deal-bridge.js";
import {
  buildUploadForm,
  inlineModule,
  patchBundle,
  uploadMetadata
} from "../scripts/patch-workers-exhibition-deal.mjs";
import { parseMultipart } from "../scripts/lib/cloudflare-api.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("start payload parsing mirrors the bot payload grammar", () => {
  assert.deepEqual(parseExhibitionDealStart("/start heatpower2026_deal_c3"), {
    raw: "heatpower2026_deal_c3",
    eventKey: "heatpower2026",
    companyId: "c3"
  });
  assert.deepEqual(parseExhibitionDealStart("/start@cmr_management_bot heatpower2026_deal_c3"), {
    raw: "heatpower2026_deal_c3",
    eventKey: "heatpower2026",
    companyId: "c3"
  });
  assert.deepEqual(parseExhibitionDealStart("/start deal_c3"), {
    raw: "deal_c3",
    eventKey: "",
    companyId: "c3"
  });
  assert.deepEqual(parseExhibitionDealStart("/start HeatPower2026_deal_C3"), {
    raw: "HeatPower2026_deal_C3",
    eventKey: "heatpower2026",
    companyId: "c3"
  });
});

test("start payload parsing rejects everything that is not an exhibition payload", () => {
  assert.equal(parseExhibitionDealStart("/start"), null);
  assert.equal(parseExhibitionDealStart("/start hello"), null);
  assert.equal(parseExhibitionDealStart("heatpower2026_deal_c3"), null);
  assert.equal(parseExhibitionDealStart("/help"), null);
  // The grammar mirrors the worker: a company id never contains a hyphen.
  assert.equal(parseExhibitionDealStart("/start heatpower2026_deal_heatpower2026-3"), null);
});

test("bridge request body carries the payload and the chat context", () => {
  assert.deepEqual(
    buildExhibitionDealRequestBody(
      { raw: "heatpower2026_deal_c3", eventKey: "heatpower2026", companyId: "c3" },
      { chatId: 1714048, userId: 42, userName: "operator" }
    ),
    {
      eventKey: "heatpower2026",
      companyId: "c3",
      payload: "heatpower2026_deal_c3",
      chatId: "1714048",
      userId: "42",
      userName: "operator"
    }
  );
});

test("bridge request normalization rejects unusable input", () => {
  assert.deepEqual(normalizeExhibitionDealRequest({ eventKey: "heatpower2026", companyId: "c3" }), {
    ok: true,
    eventKey: "heatpower2026",
    companyId: "c3",
    chatId: "",
    userId: "",
    userName: "",
    dryRun: false
  });
  assert.equal(normalizeExhibitionDealRequest({}).ok, false);
  assert.equal(normalizeExhibitionDealRequest({ companyId: "heatpower2026-3" }).ok, false);
  assert.equal(normalizeExhibitionDealRequest({ companyId: "c3", eventKey: "bad key" }).ok, false);
  assert.equal(normalizeExhibitionDealRequest({ companyId: "c3", dryRun: "yes" }).dryRun, false);
  assert.equal(normalizeExhibitionDealRequest({ companyId: "c3", dryRun: true }).dryRun, true);
});

test("bridge reply format separates a created deal from a failure", () => {
  const success = formatExhibitionDealResult({
    ok: true,
    companyName: "ООО Ромашка",
    sourceLabel: "HeatPower 2026",
    eventKey: "heatpower2026",
    dealId: "1714049",
    dealUrl: "https://app.weeek.com/crm/deals/1714049",
    preleadId: "site_heatpower2026_c3"
  });
  assert.match(success, /Сделка создана: ООО Ромашка/);
  assert.match(success, /Источник: HeatPower 2026/);
  assert.match(success, /ID сделки: 1714049/);
  assert.match(success, /Лид: site_heatpower2026_c3/);

  const failure = formatExhibitionDealResult({ ok: false, error: "company_not_found" });
  assert.match(failure, /Не удалось создать сделку из каталога/);
  assert.match(failure, /company_not_found/);

  const existing = formatExhibitionDealResult({
    ok: true,
    existingDeal: true,
    companyName: "ООО Ромашка",
    dealId: "1714049"
  });
  assert.match(existing, /Сделка уже создана: ООО Ромашка/);
  assert.match(existing, /ID сделки: 1714049/);
});

test("dry-run reply format never claims that a deal was created", () => {
  const text = formatExhibitionDealDryRun({
    ok: true,
    companyName: "ООО Ромашка",
    sourceLabel: "HeatPower 2026",
    title: "ООО Ромашка — HeatPower 2026",
    preleadId: "site_heatpower2026_c3"
  });
  assert.match(text, /Dry-run/);
  assert.doesNotMatch(text, /Сделка создана/);
});

test("inlining a module drops the export keywords", () => {
  const inlined = inlineModule("export function a() {}\nexport const b = 1;\n");
  assert.equal(inlined, "function a() {}\nconst b = 1;\n");
});

test("patching a bundle injects the hook exactly once", () => {
  const bundle = [
    "async function dispatchInner(update, env) {",
    "  const text = msg.text || \"\";",
    "  if (text.startsWith(\"/\")) {",
    "    await cancelSupplementForCommand(env, chatId, threadIdOf(msg));",
    "    await handleCommand(msg, env);",
    "  }",
    "}",
    "export { dispatchInner };"
  ].join("\n");
  const patched = patchBundle(bundle, {
    module: "export const marker = 1;",
    injection: "function injected() { return marker; }",
    injectionName: "test.js",
    anchor: [
      "  if (text.startsWith(\"/\")) {",
      "    await cancelSupplementForCommand(env, chatId, threadIdOf(msg));",
      "    await handleCommand(msg, env);"
    ].join("\n"),
    hook: "  const exhibitionStart = parseExhibitionDealStart(text);\n"
  });
  assert.equal(patched.split("parseExhibitionDealStart(text)").length - 1, 1);
  assert.match(patched, /function injected\(\)/);
  assert.match(patched, /const marker = 1;/);
  assert.match(patched, /export \{ dispatchInner \};/);
  assert.ok(patched.indexOf("parseExhibitionDealStart(text)") < patched.indexOf('if (text.startsWith("/"))'));
});

test("patching a bundle is idempotent", () => {
  const bundle = [
    "async function dispatchInner(update, env) {",
    "  const text = msg.text || \"\";",
    "  if (text.startsWith(\"/\")) {",
    "    await cancelSupplementForCommand(env, chatId, threadIdOf(msg));",
    "    await handleCommand(msg, env);",
    "  }",
    "}",
    "export { dispatchInner };"
  ].join("\n");
  const options = {
    module: "export const marker = 1;",
    injection: "function injected() { return marker; }",
    injectionName: "test.js",
    anchor: [
      "  if (text.startsWith(\"/\")) {",
      "    await cancelSupplementForCommand(env, chatId, threadIdOf(msg));",
      "    await handleCommand(msg, env);"
    ].join("\n"),
    hook: "  const exhibitionStart = parseExhibitionDealStart(text);\n"
  };
  const once = patchBundle(bundle, options);
  const twice = patchBundle(once, options);
  assert.equal(twice, once);
  assert.equal(twice.split("parseExhibitionDealStart(text)").length - 1, 1);
  assert.equal(twice.split("function injected()").length - 1, 1);
});

test("a legacy patch without markers is replaced instead of duplicated", () => {
  const bundle = [
    "async function handleRequest(request, env) {",
    "  if (request.method === \"POST\" && url.pathname === EXHIBITION_DEAL_API_PATH) {",
    "    return handleExhibitionDealRequest(request, env);",
    "  }",
    "  return jsonResponse({ ok: true });",
    "}",
    "export { handleRequest };"
  ].join("\n");
  const hook = [
    "  if (request.method === \"POST\" && url.pathname === EXHIBITION_DEAL_API_PATH) {",
    "    return handleExhibitionDealRequest(request, env);",
    "  }",
    ""
  ].join("\n");
  const patched = patchBundle(bundle, {
    module: "export const marker = 1;",
    injection: "function injected() { return marker; }",
    injectionName: "test.js",
    anchor: "  return jsonResponse({ ok: true });",
    hook
  });
  assert.equal(patched.split("EXHIBITION_DEAL_API_PATH").length - 1, 1);
  assert.equal(patched.split("function injected()").length - 1, 1);
});

test("patching a bundle fails loudly when the anchor is missing or ambiguous", () => {
  const bundle = "export { a };\n";
  assert.throws(
    () => patchBundle(bundle, {
      module: "",
      injection: "",
      anchor: "  if (missing) {",
      hook: ""
    }),
    /anchor found 0 times/
  );
  assert.throws(
    () => patchBundle("if (dup) {}\nif (dup) {}\n", {
      module: "",
      injection: "",
      anchor: "if (dup) {",
      hook: ""
    }),
    /anchor found 2 times/
  );
});

test("multipart bodies survive a round trip", async () => {
  const form = buildUploadForm({
    metadata: { main_module: "index.js" },
    files: [{ name: "index.js", content: "export default {};\n" }]
  });
  assert.deepEqual(JSON.parse(form.get("metadata")), { main_module: "index.js" });
  const module = form.get("index.js");
  assert.equal(module.name, "index.js");
  assert.equal(module.type, "application/javascript+module");
  assert.equal(await module.text(), "export default {};\n");
});

test("a downloaded worker bundle can be parsed back into its modules", () => {
  const body = [
    "--boundary",
    "Content-Disposition: form-data; name=\"index.js\"",
    "",
    "export default {};",
    "--boundary--",
    ""
  ].join("\r\n");
  const parts = parseMultipart(body);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].name, "index.js");
  assert.equal(parts[0].content, "export default {};");
});

test("upload metadata keeps the worker configuration and the binding types", () => {
  const metadata = uploadMetadata(
    {
      compatibility_date: "2024-01-01",
      compatibility_flags: ["nodejs_compat"],
      bindings: [{ name: "TOKEN", type: "secret_text" }, { name: "URL", type: "plain_text" }]
    },
    { mainModule: "index.js", keepBindingTypes: ["secret_text", "plain_text"] }
  );
  assert.equal(metadata.main_module, "index.js");
  assert.equal(metadata.compatibility_date, "2024-01-01");
  assert.deepEqual(metadata.compatibility_flags, ["nodejs_compat"]);
  assert.deepEqual(metadata.keep_bindings, ["secret_text", "plain_text"]);
  assert.equal(metadata.bindings, undefined);
});

test("the sales bot handler calls the bridge and reports the result", async () => {
  const bridge = await readFile(resolve(repoRoot, "src/exhibition-deal-bridge.js"), "utf8");
  const handler = await readFile(resolve(repoRoot, "src/worker-patches/exhibition-deal-sales-handler.js"), "utf8");
  const calls = [];
  const sent = [];
  const context = {
    console,
    sendMessage: (token, chatId, text, extra) => {
      sent.push({ token, chatId, text, extra });
    },
    getSession: async () => ({ username: "operator" }),
    threadExtra: (threadId) => (threadId ? { message_thread_id: threadId } : {}),
    threadIdOf: () => undefined,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          ok: true,
          companyName: "ООО Ромашка",
          sourceLabel: "Heat&Power 2026",
          dealId: "1714049",
          dealUrl: "https://app.weeek.com/crm/deals/1714049"
        })
      };
    }
  };
  vm.createContext(context);
  vm.runInContext(`${inlineModule(bridge)}\n${handler}\n;globalThis.__handler = handleExhibitionDealStart;`, context);

  const env = {
    BOT_TOKEN: "token",
    SESSIONS: {},
    EXHIBITION_DEAL_API_URL: "https://bridge.example.invalid/",
    EXHIBITION_DEAL_API_KEY: "secret"
  };
  const payload = { raw: "heatpower2026_deal_c3", eventKey: "heatpower2026", companyId: "c3" };
  const result = await context.__handler({ from: { id: 42, username: "operator" } }, env, 1714048, payload);

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://bridge.example.invalid/api/exhibition/deal");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["X-Exhibition-Key"], "secret");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    eventKey: "heatpower2026",
    companyId: "c3",
    payload: "heatpower2026_deal_c3",
    chatId: "1714048",
    userId: "42",
    userName: "operator"
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, 1714048);
  assert.match(sent[0].text, /Сделка создана: ООО Ромашка/);
  assert.match(sent[0].text, /ID сделки: 1714049/);
});

test("the sales bot handler refuses to work without a login or a bridge", async () => {
  const bridge = await readFile(resolve(repoRoot, "src/exhibition-deal-bridge.js"), "utf8");
  const handler = await readFile(resolve(repoRoot, "src/worker-patches/exhibition-deal-sales-handler.js"), "utf8");
  const sent = [];
  const context = {
    console,
    sendMessage: (token, chatId, text) => sent.push(text),
    getSession: async () => null,
    threadExtra: () => ({}),
    threadIdOf: () => undefined,
    fetch: async () => {
      throw new Error("the bridge must not be called");
    }
  };
  vm.createContext(context);
  vm.runInContext(`${inlineModule(bridge)}\n${handler}\n;globalThis.__handler = handleExhibitionDealStart;`, context);

  const payload = { raw: "heatpower2026_deal_c3", eventKey: "heatpower2026", companyId: "c3" };
  const withoutLogin = await context.__handler({ from: { id: 42 } }, {
    BOT_TOKEN: "token",
    SESSIONS: {},
    EXHIBITION_DEAL_API_URL: "https://bridge.example.invalid",
    EXHIBITION_DEAL_API_KEY: "secret"
  }, 1714048, payload);
  assert.equal(withoutLogin.ok, false);
  assert.equal(withoutLogin.error, "login_required");
  assert.match(sent[0], /\/login/);

  const withoutBridge = await context.__handler({ from: { id: 42 } }, {
    BOT_TOKEN: "token",
    SESSIONS: {}
  }, 1714048, payload);
  assert.equal(withoutBridge.ok, false);
  assert.equal(withoutBridge.error, "bridge_not_configured");
  assert.match(sent[1], /Мост выставочных сделок не настроен/);
});

test("the patched worker bundles are syntactically valid", async () => {
  const cases = [
    {
      role: "legacy",
      bundle: [
        "async function handleRequest(request, env) {",
        "  const url = new URL(request.url);",
        "  if (url.pathname === SITE_PREDEAL_NOTES_PATH) {",
        "    return handleSitePredealNotesRequest(request, env);",
        "  }",
        "  return jsonResponse({ ok: true });",
        "}",
        "export { handleRequest };"
      ].join("\n"),
      anchor: "  if (url.pathname === SITE_PREDEAL_NOTES_PATH) {",
      hook: "  if (request.method === \"POST\" && url.pathname === EXHIBITION_DEAL_API_PATH) {\n    return handleExhibitionDealRequest(request, env);\n  }\n",
      injection: await readFile(resolve(repoRoot, "src/worker-patches/exhibition-deal-legacy-endpoint.js"), "utf8")
    },
    {
      role: "sales",
      bundle: [
        "async function dispatchInner(update, env) {",
        "  const text = msg.text || \"\";",
        "  if (text.startsWith(\"/\")) {",
        "    await cancelSupplementForCommand(env, chatId, threadIdOf(msg));",
        "    await handleCommand(msg, env);",
        "  }",
        "}",
        "export { dispatchInner };"
      ].join("\n"),
      anchor: [
        "  if (text.startsWith(\"/\")) {",
        "    await cancelSupplementForCommand(env, chatId, threadIdOf(msg));",
        "    await handleCommand(msg, env);"
      ].join("\n"),
      hook: "  const exhibitionStart = parseExhibitionDealStart(text);\n",
      injection: await readFile(resolve(repoRoot, "src/worker-patches/exhibition-deal-sales-handler.js"), "utf8")
    }
  ];
  const module = await readFile(resolve(repoRoot, "src/exhibition-deal-bridge.js"), "utf8");
  const dir = await mkdtemp(join(tmpdir(), "exhibition-patch-"));
  for (const item of cases) {
    const patched = patchBundle(item.bundle, {
      module,
      injection: item.injection,
      injectionName: `${item.role}.js`,
      anchor: item.anchor,
      hook: item.hook
    });
    const file = join(dir, `${item.role}.mjs`);
    await writeFile(file, patched, "utf8");
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    assert.equal(result.status, 0, `${item.role}: ${result.stderr || result.stdout}`);
  }
});
