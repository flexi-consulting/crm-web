import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';

test('D1 migration sequence numbers are unique', async () => {
  const files = (await readdir(new URL('../migrations/', import.meta.url)))
    .filter(name => /^\d{4}_.+\.sql$/.test(name));
  const versions = files.map(name => name.slice(0, 4));
  assert.equal(new Set(versions).size, versions.length,
    `duplicate migration ordinals: ${versions.filter((version, index) => versions.indexOf(version) !== index).join(', ')}`);
});
