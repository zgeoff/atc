import { expect, mock, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runLocalCommand, setupTempDir } from '@atc/test-utils';
import { buildHostFiles } from './build-host-files';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-host-files-');

  return { directory: temporaryDirectory.path };
}

test('it reads the lines that match the pattern', async () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 'a-1.jsonl');

  writeFileSync(path, '{"type":"user"}\n{"type":"summary"}\n{"type":"custom-title"}\n');

  const lines = await buildHostFiles(runLocalCommand, 'host-1').readMatchingLines(
    path,
    '"type":"(custom-title|summary)"',
  );

  expect(lines).toStrictEqual(['{"type":"summary"}', '{"type":"custom-title"}']);
});

test('it reads every line for an empty pattern', async () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 'summary.json');

  writeFileSync(path, '{\n  "generated_title": "tidy the docs"\n}\n');

  const lines = await buildHostFiles(runLocalCommand, 'host-1').readMatchingLines(path, '');

  expect(lines).toStrictEqual(['{', '  "generated_title": "tidy the docs"', '}']);
});

test('it reads no lines from a file where none match', async () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 'a-1.jsonl');

  writeFileSync(path, '{"type":"user"}\n');

  const lines = await buildHostFiles(runLocalCommand, 'host-1').readMatchingLines(
    path,
    'custom-title',
  );

  expect(lines).toStrictEqual([]);
});

test('it reads no lines from a file the host does not hold', async () => {
  const ctx = setupTest();

  const lines = await buildHostFiles(runLocalCommand, 'host-1').readMatchingLines(
    join(ctx.directory, 'missing.jsonl'),
    '',
  );

  expect(lines).toBeNull();
});

test('it runs the line read on the session host', async () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 'a-1.jsonl');
  const runCommand = mock(runLocalCommand);

  writeFileSync(path, '{"type":"user"}\n');

  await buildHostFiles(runCommand, 'host-1').readMatchingLines(path, '');

  expect(runCommand).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ host: 'host-1' }));
});

test('it reads no lines when the host refuses the command', async () => {
  const lines = await buildHostFiles(
    () => Promise.reject(new Error('the host is asleep')),
    'host-1',
  ).readMatchingLines('/tmp/atc/sessions/s-1/a-1.jsonl', '');

  expect(lines).toBeNull();
});

test('it reads the names in a directory, hidden ones included', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directory, '%2Fwork'));
  writeFileSync(join(ctx.directory, '.hidden'), '');

  const names = await buildHostFiles(runLocalCommand, 'host-1').readDirectory(ctx.directory);

  expect(names).toIncludeSameMembers(['%2Fwork', '.hidden']);
});

test('it reads no names from an empty directory', async () => {
  const ctx = setupTest();

  const names = await buildHostFiles(runLocalCommand, 'host-1').readDirectory(ctx.directory);

  expect(names).toStrictEqual([]);
});

test('it reads no names from a directory the host does not hold', async () => {
  const ctx = setupTest();

  const names = await buildHostFiles(runLocalCommand, 'host-1').readDirectory(
    join(ctx.directory, 'missing'),
  );

  expect(names).toBeNull();
});

test('it runs the listing on the session host', async () => {
  const ctx = setupTest();
  const runCommand = mock(runLocalCommand);

  await buildHostFiles(runCommand, 'host-1').readDirectory(ctx.directory);

  expect(runCommand).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ host: 'host-1' }));
});

test('it reads no names when the host refuses the command', async () => {
  const names = await buildHostFiles(
    () => Promise.reject(new Error('the host is asleep')),
    'host-1',
  ).readDirectory('/root/.grok/sessions');

  expect(names).toBeNull();
});
