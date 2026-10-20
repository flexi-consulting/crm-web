// Applies the bindings the exhibition deal bridge needs.
//
//   flexi-telegram-deal-bot     - EXHIBITION_DEAL_API_KEY (secret)
//                                 TELEGRAM_DEAL_EVENT_META_JSON (event names)
//   trained-assist-tg-bot-sales - EXHIBITION_DEAL_API_KEY (secret)
//                                 EXHIBITION_DEAL_API_URL (the bridge url)
//
// The secret value is never stored in the repository: it is read from the
// EXHIBITION_DEAL_API_KEY environment variable.
//
// Usage:
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
//   EXHIBITION_DEAL_API_KEY=... \
//     node scripts/apply-exhibition-worker-bindings.mjs

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  diffBindings,
  fetchWorkerSettings,
  patchWorkerSettings,
  setWorkerSecret
} from "./lib/cloudflare-api.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const workers = {
  legacy: "flexi-telegram-deal-bot",
  sales: "trained-assist-tg-bot-sales"
};

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID is required");

const secretValue = process.env.EXHIBITION_DEAL_API_KEY;
const bridgeUrl = process.env.EXHIBITION_DEAL_API_URL
  || "https://flexi-telegram-deal-bot.skillset-apply.workers.dev";
const eventMeta = await readFile(resolve(repoRoot, "fixtures/exhibition-event-meta.json"), "utf8");

const plainText = (name, text) => ({ name, type: "plain_text", text });

const plan = {
  [workers.legacy]: [
    plainText("TELEGRAM_DEAL_EVENT_META_JSON", eventMeta),
    plainText("EXHIBITION_DEAL_API_URL", bridgeUrl)
  ],
  [workers.sales]: [plainText("EXHIBITION_DEAL_API_URL", bridgeUrl)]
};

const report = [];
for (const [name, additions] of Object.entries(plan)) {
  if (secretValue) {
    await setWorkerSecret(accountId, name, "EXHIBITION_DEAL_API_KEY", secretValue);
  }
  const before = await fetchWorkerSettings(accountId, name);
  const bindings = (before.bindings || []).map((binding) => ({ ...binding }));
  const known = new Set(bindings.map((binding) => binding.name));
  for (const addition of additions) {
    if (known.has(addition.name)) {
      const index = bindings.findIndex((binding) => binding.name === addition.name);
      bindings[index] = { ...bindings[index], type: addition.type, text: addition.text };
    } else {
      bindings.push(addition);
    }
  }
  await patchWorkerSettings(accountId, name, bindings);
  const after = await fetchWorkerSettings(accountId, name);
  report.push({ worker: name, secretSet: Boolean(secretValue), ...diffBindings(before, after) });
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
