// Keep exhibition acceptance traffic in the test chats and published catalog
// traffic in the production group. PATCH replaces the entire binding list, so
// this script preserves every unrelated binding and verifies the readback.

import { fetchWorkerSettings, patchWorkerSettings } from "./lib/cloudflare-api.mjs";

export const TEST_CHAT_ID = "-5441770657";
export const PRODUCTION_CHAT_ID = "-1004485888030";
const WORKER = "flexi-telegram-deal-bot";
const EXTRA = "TELEGRAM_EXTRA_ALLOWED_CHAT_IDS";
const TEST = "TELEGRAM_TEST_CHAT_IDS";

const ids = (value) => String(value || "").split(",").map((id) => id.trim()).filter(Boolean);
const unique = (values) => [...new Set(values)];

export function planExhibitionChatBindings(bindings) {
  const byName = new Map(bindings.map((binding) => [binding.name, binding]));
  const extra = byName.get(EXTRA);
  const test = byName.get(TEST);
  if (extra?.type !== "plain_text" || test?.type !== "plain_text") {
    throw new Error("Expected both chat bindings to be plain_text");
  }
  const extraIds = unique([...ids(extra.text).filter((id) => id !== TEST_CHAT_ID), PRODUCTION_CHAT_ID]);
  const testIds = unique([...ids(test.text).filter((id) => id !== PRODUCTION_CHAT_ID), TEST_CHAT_ID]);
  return bindings.map((binding) => {
    if (binding.name === EXTRA) return { ...binding, text: extraIds.join(",") };
    if (binding.name === TEST) return { ...binding, text: testIds.join(",") };
    return { ...binding };
  });
}

export function verifyExhibitionChatBindings(before, planned, after) {
  const original = new Map(before.map((binding) => [binding.name, JSON.stringify(binding)]));
  const expected = new Map(planned.map((binding) => [binding.name, JSON.stringify(binding)]));
  const actual = new Map(after.map((binding) => [binding.name, JSON.stringify(binding)]));
  if (original.size !== before.length || expected.size !== planned.length || actual.size !== after.length ||
      original.size !== actual.size) throw new Error("Binding count or names changed");
  for (const [name, value] of expected) {
    if (actual.get(name) !== value) throw new Error(`Unexpected readback for ${name}`);
  }
  for (const [name, value] of original) {
    if (name !== EXTRA && name !== TEST && actual.get(name) !== value) {
      throw new Error(`Unrelated binding changed: ${name}`);
    }
  }
  return {
    worker: WORKER,
    bindingCount: actual.size,
    secretCount: after.filter((binding) => binding.type === "secret_text").length,
    testChatIds: ids(after.find((binding) => binding.name === TEST)?.text),
    productionExtraChatIds: ids(after.find((binding) => binding.name === EXTRA)?.text)
  };
}

export async function main() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID is required");
  const before = (await fetchWorkerSettings(accountId, WORKER)).bindings || [];
  const planned = planExhibitionChatBindings(before);
  const changed = before.some((binding, index) => JSON.stringify(binding) !== JSON.stringify(planned[index]));
  if (changed) await patchWorkerSettings(accountId, WORKER, planned);
  let report;
  try {
    const after = (await fetchWorkerSettings(accountId, WORKER)).bindings || [];
    report = verifyExhibitionChatBindings(before, planned, after);
  } catch (error) {
    if (changed) {
      await patchWorkerSettings(accountId, WORKER, before);
      const restored = (await fetchWorkerSettings(accountId, WORKER)).bindings || [];
      verifyExhibitionChatBindings(before, before, restored);
    }
    throw error;
  }
  process.stdout.write(`${JSON.stringify({ ...report, changed }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main();
}
