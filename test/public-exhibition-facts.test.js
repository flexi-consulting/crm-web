import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureLegacyCatalogs, verifyLegacyCatalogBackup } from "../src/private-legacy-handoff.js";
import { preparePublicExhibitionSnapshot } from "../src/public-exhibition-private-import.js";
import { createPublicExhibitionReadHandler } from "../src/public-exhibition-facts.js";

const eventKey = "invented-expo-2026";
const origin = "https://crm.example.invalid";
const req = (path, method = "GET") => new Request(`${origin}${path}`, { method });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "crm-public-facts-"));
  const sourceRoot = join(root, "users");
  const deployed = join(sourceRoot, "old-namespace", "projects", "invented", "deploy", eventKey);
  await mkdir(deployed, { recursive: true });
  const rows = [
    { id: "DUP", n: "Invented Textile", s: "A-01", t: 1, nt: 0, rev: 500,
      e: "private@example.invalid", p: "+1 999 555 0100", contact: "Private Contact" },
    { id: "DUP", n: "Invented Flowers", s: "A-02", t: 0, nt: 1,
      note: "Private note", dealStatus: "created" }
  ];
  await writeFile(join(deployed, "index.html"),
    `<html><script>const EX = ${JSON.stringify(rows)}; const EVENT_KEY = '${eventKey}';</script></html>`);
  const backup = join(root, "backup");
  await captureLegacyCatalogs({ sourceRoot, outputDir: backup });
  const manifest = await verifyLegacyCatalogBackup(backup);
  const source = manifest.records.find((item) => item.kind === "deployed_html");
  const decision = { eventKey, eventTitle: "Invented Expo", sourcePath: source.sourcePath,
    sourceSha256: source.objectSha256, publicSourceUrl: "https://publisher.example.invalid/expo",
    rightsEvidenceUrl: "https://publisher.example.invalid/republication-approval",
    rightsDecision: "publisher_approved_republication", reviewers: ["publisher-owner", "second-reviewer"] };
  return { root, backup, decision };
}

test("private receipt projects only reviewed public facts; browser and API share projection", async () => {
  const f = await fixture();
  try {
    const { snapshot, receipt } = await preparePublicExhibitionSnapshot({ backupDir: f.backup,
      decision: f.decision });
    assert.equal(receipt.sourceSha256, f.decision.sourceSha256);
    assert.equal(snapshot.participants.length, 2);
    assert.notEqual(snapshot.participants[0].id, snapshot.participants[1].id);
    assert.deepEqual(Object.keys(snapshot.participants[0]).sort(), ["id", "name", "stand"]);
    const handler = await createPublicExhibitionReadHandler({ enabled: true, snapshots: [snapshot],
      approvedProjectionShas: { [eventKey]: receipt.projectionSha256 } });
    const listing = await handler(req("/public/exhibitions"));
    assert.deepEqual((await listing.json()).items, [{ eventKey, eventTitle: "Invented Expo", count: 2 }]);
    const api = await handler(req(`/public/exhibitions/${eventKey}`));
    assert.deepEqual(await api.json(), { eventKey, eventTitle: "Invented Expo",
      participants: snapshot.participants });
    const page = await handler(req(`/exhibitions/${eventKey}`));
    const html = await page.text();
    assert.match(html, /Invented Textile/);
    assert.match(html, /Invented Flowers/);
    assert.doesNotMatch(html + JSON.stringify(snapshot), /Private Contact|Private note|private@example|999 555|dealStatus|revenueRub/);
    assert.equal(page.headers.get("content-security-policy")?.includes("default-src 'none'"), true);
    assert.equal((await handler(req(`/exhibitions/${eventKey}`, "POST"))).status, 404);
    assert.equal((await handler(req(`/exhibitions/${eventKey}?profileId=someone`))).status, 404);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("publication needs exact byte receipt and two distinct reviewers", async () => {
  const f = await fixture();
  try {
    for (const decision of [
      { ...f.decision, sourceSha256: "0".repeat(64) },
      { ...f.decision, reviewers: ["same", "same"] },
      { ...f.decision, rightsDecision: "unknown" },
      { ...f.decision, rightsEvidenceUrl: "http://insecure.example.invalid" }
    ]) await assert.rejects(preparePublicExhibitionSnapshot({ backupDir: f.backup, decision }));
    const { snapshot } = await preparePublicExhibitionSnapshot({ backupDir: f.backup, decision: f.decision });
    await assert.rejects(createPublicExhibitionReadHandler({ enabled: true, snapshots: [snapshot],
      approvedProjectionShas: { [eventKey]: "0".repeat(64) } }), /public_projection_receipt_mismatch/);
    assert.equal((await (await createPublicExhibitionReadHandler())(req("/public/exhibitions"))).status, 404);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
