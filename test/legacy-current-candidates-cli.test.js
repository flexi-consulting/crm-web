import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureLegacyCatalogs } from "../src/private-legacy-handoff.js";

const script = new URL("../scripts/legacy-current-candidates.mjs", import.meta.url).pathname;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("private candidate CLI checks source bytes and writes no IDs to stdout", async () => {
  const root = await mkdtemp(join(tmpdir(), "crm-current-candidates-"));
  try {
    const sourceRoot = join(root, "users");
    const deploy = join(sourceRoot, "demo-old-user", "projects", "demo-project",
      "deploy", "demo-expo");
    await mkdir(deploy, { recursive: true });
    const html = Buffer.from(`<script>const EX = [{"id":"SAMPLE001","n":"Invented Maker"}];\nconst EVENT_KEY = 'demo-expo';</script>`);
    await writeFile(join(deploy, "index.html"), html);
    const backup = join(root, "backup"), capture = await captureLegacyCatalogs({ sourceRoot,
      outputDir: backup });
    const sourcePath = "demo-old-user/projects/demo-project/deploy/demo-expo/index.html";
    const report = { version: 1, sourceReceipts: { current: capture.manifestSha256,
      historical: "b".repeat(64), notesSql: "c".repeat(64) }, records: [
      { preleadId: "site_demo-expo_sample001", status: "current_unique_evidence",
        currentCandidates: [{ sourceSha256: sha(html), sourcePath,
          eventKey: "demo-expo", rowIndex: 0, legacyCompanyId: "SAMPLE001" }],
        historicalCandidates: [], dealMessageCount: 0 }
    ] };
    const reportBytes = Buffer.from(JSON.stringify(report));
    const reportFile = join(root, "report.json"), receiptsFile = join(root, "receipts.json"),
      outputFile = join(root, "candidates.json");
    await writeFile(reportFile, reportBytes, { mode: 0o600 });
    await writeFile(receiptsFile, JSON.stringify({ ...report.sourceReceipts,
      correlationReport: sha(reportBytes) }), { mode: 0o600 });
    const stdout = execFileSync(process.execPath,
      [script, reportFile, receiptsFile, backup, outputFile], { encoding: "utf8" });
    assert.equal(stdout.includes("SAMPLE001"), false);
    assert.equal(JSON.parse(stdout).currentUnique, 1);
    assert.equal((await stat(outputFile)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(outputFile, "utf8"))
      .candidates[0].oldOwnerNamespace, "demo-old-user");
    await writeFile(reportFile, Buffer.concat([reportBytes, Buffer.from(" ")]));
    assert.throws(() => execFileSync(process.execPath,
      [script, reportFile, receiptsFile, backup, join(root, "other.json")],
      { stdio: "pipe" }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
