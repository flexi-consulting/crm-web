// Builds the patched bundles for the two workers that implement the exhibition
// catalog deep link:
//
//   flexi-telegram-deal-bot     - the private HTTP bridge that creates the deal
//   trained-assist-tg-bot-sales - @cmr_management_bot, the bot the catalogs link to
//
// Both workers are deployed as generated bundles, so the injected code lives in
// this repository and is inlined into the bundles by this script:
//
//   src/exhibition-deal-bridge.js
//   src/worker-patches/exhibition-deal-legacy-endpoint.js
//   src/worker-patches/exhibition-deal-sales-handler.js
//
// Usage:
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
//     node scripts/patch-workers-exhibition-deal.mjs --out .tmp/workers
//   node scripts/patch-workers-exhibition-deal.mjs --out .tmp/workers --upload
//
// The upload keeps every existing binding: the script metadata is rebuilt from
// the live worker settings, and the secret bindings are kept as they are.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  apiRequest,
  diffBindings,
  fetchWorkerBundle,
  fetchWorkerSettings,
  parseMultipart
} from "./lib/cloudflare-api.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const targets = [
  {
    name: "flexi-telegram-deal-bot",
    role: "legacy",
    injection: "src/worker-patches/exhibition-deal-legacy-endpoint.js",
    anchor: "  if (url.pathname === SITE_PREDEAL_NOTES_PATH) {",
    hook: [
      "  if (request.method === \"POST\" && url.pathname === EXHIBITION_DEAL_API_PATH) {",
      "    return handleExhibitionDealRequest(request, env);",
      "  }",
      ""
    ].join("\n")
  },
  {
    name: "trained-assist-tg-bot-sales",
    role: "sales",
    injection: "src/worker-patches/exhibition-deal-sales-handler.js",
    anchor: [
      "  if (text.startsWith(\"/\")) {",
      "    await cancelSupplementForCommand(env, chatId, threadIdOf(msg));",
      "    await handleCommand(msg, env);"
    ].join("\n"),
    hook: [
      "  const exhibitionStart = parseExhibitionDealStart(text);",
      "  if (exhibitionStart) {",
      "    await cancelSupplementForCommand(env, chatId, threadIdOf(msg));",
      "    await handleExhibitionDealStart(msg, env, chatId, exhibitionStart);",
      "    return;",
      "  }",
      ""
    ].join("\n")
  }
];

export function inlineModule(source) {
  return String(source)
    .replace(/^export\s+(?=(async\s+)?function|const|let|var|class)/gm, "")
    .replace(/^export\s*\{[^}]*\};?\s*$/gm, "");
}

export function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

export function stripInjected(source, label) {
  const startPattern = new RegExp(`// --- exhibition deal ${label}[^\\n]*\\n`);
  const endMarker = `// --- exhibition deal ${label}: end ---`;
  const match = source.match(startPattern);
  if (!match) return source;
  const from = match.index;
  const to = source.indexOf(endMarker, from);
  if (to === -1) throw new Error(`the injected block "${label}" is not terminated`);
  let end = to + endMarker.length;
  if (source.startsWith("\n", end)) end += 1;
  if (source.startsWith("\n", end)) end += 1;
  return `${source.slice(0, from)}${source.slice(end)}`;
}

export function patchBundle(bundle, options) {
  const { module, injection, anchor, hook } = options;
  let base = bundle;
  for (const label of ["bridge", "patch", "hook"]) base = stripInjected(base, label);
  const hookText = String(hook).trimEnd();
  if (hookText) base = base.split(hookText).join("");
  const anchorCount = countOccurrences(base, anchor);
  if (anchorCount !== 1) {
    throw new Error(`anchor found ${anchorCount} times, expected exactly 1`);
  }
  const exportIndex = base.lastIndexOf("export {");
  const insertAt = exportIndex === -1 ? base.length : exportIndex;
  const injected = [
    "// --- exhibition deal bridge: start ---",
    `// source: src/exhibition-deal-bridge.js`,
    inlineModule(module).trim(),
    "// --- exhibition deal bridge: end ---",
    "",
    "// --- exhibition deal patch: start ---",
    `// source: ${options.injectionName || "injection"}`,
    String(injection).trim(),
    "// --- exhibition deal patch: end ---",
    ""
  ].join("\n");
  const withCode = `${base.slice(0, insertAt)}${injected}\n${base.slice(insertAt)}`;
  const anchorIndex = withCode.indexOf(anchor);
  if (anchorIndex === -1) throw new Error("anchor disappeared after the patch was applied");
  const hooked = [
    "// --- exhibition deal hook: start ---",
    hookText,
    "// --- exhibition deal hook: end ---",
    ""
  ].join("\n");
  return `${withCode.slice(0, anchorIndex)}${hooked}\n${withCode.slice(anchorIndex)}`;
}

export function buildUploadForm({ metadata, files }) {
  const form = new FormData();
  form.set("metadata", JSON.stringify(metadata));
  for (const file of files) {
    form.set(file.name, new File([file.content], file.name, { type: "application/javascript+module" }));
  }
  return form;
}

export function uploadMetadata(settings, { mainModule, keepBindingTypes = [] }) {
  const metadata = {
    main_module: mainModule,
    compatibility_date: settings.compatibility_date,
    compatibility_flags: settings.compatibility_flags || []
  };
  if (keepBindingTypes.length) metadata.keep_bindings = keepBindingTypes;
  return metadata;
}

const checkSyntax = async (source, file) => {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`syntax check failed for ${file}: ${result.stderr || result.stdout}`);
  }
  return source.length;
};

const parseArgs = (argv) => {
  const args = { out: ".tmp/workers", upload: false, only: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--out") args.out = argv[++index];
    else if (value === "--upload") args.upload = true;
    else if (value === "--only") args.only.push(argv[++index]);
  }
  return args;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID is required");
  const module = await readFile(resolve(repoRoot, "src/exhibition-deal-bridge.js"), "utf8");
  await mkdir(resolve(repoRoot, args.out), { recursive: true });
  const summary = [];
  for (const target of targets) {
    if (args.only.length && !args.only.includes(target.role) && !args.only.includes(target.name)) continue;
    const injection = await readFile(resolve(repoRoot, target.injection), "utf8");
    const bundle = await fetchWorkerBundle(accountId, target.name);
    const parts = parseMultipart(bundle);
    const scriptPart = parts.find((part) => part.name.endsWith(".js")) || parts[0];
    if (!scriptPart) throw new Error(`${target.name}: no module part found`);
    const patched = patchBundle(scriptPart.content, {
      module,
      injection,
      injectionName: target.injection,
      anchor: target.anchor,
      hook: target.hook
    });
    const outFile = resolve(repoRoot, args.out, `${target.name}.js`);
    await writeFile(outFile, patched, "utf8");
    await checkSyntax(patched, outFile);
    const settings = await fetchWorkerSettings(accountId, target.name);
    summary.push({
      name: target.name,
      role: target.role,
      bindings: settings.bindings?.length ?? 0,
      secrets: (settings.bindings || []).filter((binding) => binding.type === "secret_text").length,
      out: outFile
    });
    if (args.upload) {
      const metadata = uploadMetadata(settings, {
        mainModule: scriptPart.name,
        keepBindingTypes: [...new Set((settings.bindings || []).map((binding) => binding.type))]
      });
      const form = buildUploadForm({
        metadata,
        files: [{ name: scriptPart.name, content: patched }]
      });
      await apiRequest(`/accounts/${accountId}/workers/scripts/${target.name}`, {
        method: "PUT",
        body: form
      });
      const after = await fetchWorkerSettings(accountId, target.name);
      const diff = diffBindings(settings, after);
      summary[summary.length - 1].uploaded = true;
      summary[summary.length - 1].bindingsAfter = diff.after;
      summary[summary.length - 1].bindingsMissing = diff.missing;
      summary[summary.length - 1].bindingsChanged = diff.changed;
    }
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
};

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
