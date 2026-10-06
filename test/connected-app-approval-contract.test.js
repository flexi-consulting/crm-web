import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const dir = "contracts/connected-app-approval-receipt-v1/";
const json = (name) => readFileSync(`${dir}${name}`);
const source = JSON.parse(readFileSync(`${dir}source.json`));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("CRM approval consumer pins the producer-owned Control Plane contract artifacts", () => {
  assert.equal(source.repository, "trained-assist/trained-assist-control-plane");
  assert.equal(source.revision, "3c0b3ad00c50570a262dc5dab51ca1fd5bc76424");
  for (const [path, expected] of Object.entries(source.artifacts)) assert.equal(sha(json(path)), expected, path);
  const contract = JSON.parse(json("contract.json"));
  assert.equal(contract.version, 1);
  assert.deepEqual(Object.keys(contract.clients), ["crm-web"]);
  assert.deepEqual(Object.keys(contract.clients["crm-web"].commands), ["crm.deals.create"]);

});
