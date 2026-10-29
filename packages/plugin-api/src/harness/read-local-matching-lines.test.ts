import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils';
import { readLocalMatchingLines } from './read-local-matching-lines';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-matching-lines-');

  return { directory: temporaryDirectory.path };
}

test('it reads the lines that match the pattern', async () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 'a-1.jsonl');

  writeFileSync(path, '{"type":"user"}\n{"type":"summary"}\n{"type":"custom-title"}\n');

  const lines = await readLocalMatchingLines(path, '"type":"(custom-title|summary)"');

  expect(lines).toStrictEqual(['{"type":"summary"}', '{"type":"custom-title"}']);
});

test('it reads every line for an empty pattern', async () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 'summary.json');

  writeFileSync(path, '{\n  "generated_title": "tidy the docs"\n}\n');

  const lines = await readLocalMatchingLines(path, '');

  expect(lines).toStrictEqual(['{', '  "generated_title": "tidy the docs"', '}']);
});

test('it reads no lines from a file where none match', async () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 'a-1.jsonl');

  writeFileSync(path, '{"type":"user"}\n');

  const lines = await readLocalMatchingLines(path, 'custom-title');

  expect(lines).toStrictEqual([]);
});

test('it reads nothing from a missing file', async () => {
  const ctx = setupTest();

  const lines = await readLocalMatchingLines(join(ctx.directory, 'missing.jsonl'), '');

  expect(lines).toBeNull();
});
