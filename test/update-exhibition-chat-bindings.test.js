import test from "node:test";
import assert from "node:assert/strict";
import {
  planExhibitionChatBindings, verifyExhibitionChatBindings
} from "../scripts/update-exhibition-chat-bindings.mjs";

test("exhibition test and production groups keep separate bindings and preserve unrelated settings", () => {
  const before = [
    { name: "TELEGRAM_EXTRA_ALLOWED_CHAT_IDS", type: "plain_text", text: "-5253164492,-5423408115,-5441770657" },
    { name: "TELEGRAM_TEST_CHAT_IDS", type: "plain_text", text: "-5213761301" },
    { name: "TELEGRAM_ALLOWED_CHAT_ID", type: "secret_text" },
    { name: "DEAL_BOT_DB", type: "d1", id: "db-id" }
  ];
  const planned = planExhibitionChatBindings(before);
  assert.deepEqual(planned.slice(0, 2).map((binding) => binding.text), [
    "-5253164492,-5423408115,-1004485888030",
    "-5213761301,-5441770657"
  ]);
  assert.deepEqual(planExhibitionChatBindings(planned), planned);
  assert.equal(verifyExhibitionChatBindings(before, planned, planned).bindingCount, 4);
  assert.throws(() => verifyExhibitionChatBindings(before, planned,
    [...planned.slice(0, 3), { ...planned[3], id: "wrong" }]), /Unrelated binding changed|Unexpected readback/);
});
