import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Ajv from "ajv/dist/2020.js";
import { projectLegacyExSnapshot } from "../src/legacy-ex-snapshot.js";

const entries = [
  { id: "LNG001", n: "Invented Loom Works", s: "A-01", t: 1, nt: 0,
    inn: "0000000001", ogrn: "0000000000001", ru: 1, rev: 250,
    href: "https://example.invalid/catalog/loom", w: "https://example.invalid/loom",
    e: "contact@example.invalid", p: "+7 000 000 00 00" },
  { id: "21_dot_12", n: "Invented Supplier", s: "A-02", t: 0, nt: 1, ru: 1, rev: null }
];

test("legacy EX projection is revisioned, schema-valid and excludes contact fields", async () => {
  const first = projectLegacyExSnapshot({ profileRef: "demo-profile-a",
    eventKey: "invented-expo-2026", entries });
  assert.equal(first.status, "projected");
  assert.equal(first.build.artifact.companies.length, 2);
  assert.equal(first.build.report.validation.valid, true);
  const ajv = new Ajv();
  for (const name of ["catalog-build-artifact", "catalog-build-report"]) {
    const schema = JSON.parse(await readFile(new URL(`../schemas/${name}.schema.json`, import.meta.url)));
    assert.equal(ajv.compile(schema)(name.endsWith("artifact") ? first.build.artifact : first.build.report),
      true, name);
  }
  assert.equal(JSON.stringify(first.build).includes("contact@example.invalid"), false);
  assert.equal(JSON.stringify(first.build).includes("+7 000"), false);
  const changedContact = projectLegacyExSnapshot({ profileRef: "demo-profile-a",
    eventKey: "invented-expo-2026", entries: [{ ...entries[0], e: "new@example.invalid" }, entries[1]] });
  assert.equal(changedContact.build.buildId, first.build.buildId);
  const renamed = projectLegacyExSnapshot({ profileRef: "demo-profile-a",
    eventKey: "invented-expo-2026", entries: [{ ...entries[0], n: "Renamed Loom" }, entries[1]] });
  assert.notEqual(first.build.buildId, renamed.build.buildId);
  assert.equal(first.legacyRefs[0].companyId, renamed.legacyRefs[0].companyId);
  const otherEvent = projectLegacyExSnapshot({ profileRef: "demo-profile-a",
    eventKey: "invented-expo-2027", entries });
  assert.notEqual(first.legacyRefs[0].companyId, otherEvent.legacyRefs[0].companyId);
  const otherProfile = projectLegacyExSnapshot({ profileRef: "demo-profile-b",
    eventKey: "invented-expo-2026", entries });
  assert.notEqual(first.build.buildId, otherProfile.build.buildId);
  assert.equal(first.legacyRefs[0].companyId, otherProfile.legacyRefs[0].companyId);
});

test("legacy EX rejects duplicate or ambiguous link IDs and unsafe URLs before persistence", () => {
  for (const bad of [
    [{ ...entries[0] }, { ...entries[1], id: "LNG001" }],
    [{ ...entries[0], id: "13C18/13D19" }],
    [{ ...entries[0], id: "13С11" }],
    [{ ...entries[0], id: ".." }]
  ]) assert.equal(projectLegacyExSnapshot({ profileRef: "demo-profile-a",
    eventKey: "invented-expo-2026", entries: bad }).status, "legacy_identity_conflict");
  assert.equal(projectLegacyExSnapshot({ profileRef: "demo-profile-a",
    eventKey: "invented-expo-2026",
    entries: [{ ...entries[0], href: "javascript:alert(1)" }] }).status, "legacy_record_invalid");
  assert.equal(projectLegacyExSnapshot({ profileRef: "demo-profile-a",
    eventKey: "invented-expo-2026",
    entries: [{ ...entries[0], t: 1, nt: 1 }] }).status, "legacy_record_invalid");
  assert.equal(projectLegacyExSnapshot({ profileRef: "demo-profile-a",
    eventKey: "invented-expo-2026",
    entries: [{ ...entries[0], inn: null }] }).status, "legacy_record_invalid");
});
