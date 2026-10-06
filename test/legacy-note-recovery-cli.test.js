import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sha = (char) => char.repeat(64);
const script = new URL("../scripts/legacy-note-recovery-plan.mjs", import.meta.url).pathname;

test("private CLI writes an owner-only pending plan without printing invented IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "crm-note-plan-"));
  try {
    const receipts = { current: sha("a"), historical: sha("b"), notesSql: sha("c") };
    const report = { version: 1, sourceReceipts: receipts, records: [
      { preleadId: "site_invented-only_company", status: "unknown_event_quarantine",
        currentCandidates: [], historicalCandidates: [], messageCount: 2, dealMessageCount: 1 }
    ] };
    const reportFile = join(root, "private-report.json"),
      receiptsFile = join(root, "private-receipts.json"), outputFile = join(root, "private-plan.json");
    const reportBytes = Buffer.from(JSON.stringify(report));
    await writeFile(reportFile, reportBytes, { mode: 0o600 });
    await writeFile(receiptsFile, JSON.stringify({ ...receipts,
      correlationReport: createHash("sha256").update(reportBytes).digest("hex") }),
    { mode: 0o600 });
    const stdout = execFileSync(process.execPath, [script, reportFile, receiptsFile, outputFile],
      { encoding: "utf8" });
    assert.equal(stdout.includes("invented-only"), false);
    assert.equal(JSON.parse(stdout).unmatchedDealMessages, 1);
    assert.equal((await stat(outputFile)).mode & 0o777, 0o600);
    const plan = JSON.parse(await readFile(outputFile, "utf8"));
    assert.equal(plan.records[0].preleadId, report.records[0].preleadId);
    assert.equal(plan.records[0].status, "pending_review");
    assert.throws(() => execFileSync(process.execPath,
      [script, reportFile, receiptsFile, outputFile], { stdio: "pipe" }));
    await writeFile(reportFile, Buffer.concat([reportBytes, Buffer.from(" ")]));
    assert.throws(() => execFileSync(process.execPath,
      [script, reportFile, receiptsFile, join(root, "second-plan.json")], { stdio: "pipe" }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
