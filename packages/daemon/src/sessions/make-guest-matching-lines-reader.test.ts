import { expect, mock, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils';
import { runLocalCommand } from '../testing/run-local-command';
import { makeGuestMatchingLinesReader } from './make-guest-matching-lines-reader';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-guest-lines-');

  return { directory: temporaryDirectory.path };
}

test('it reads the lines that match the pattern', async () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 'a-1.jsonl');

  writeFileSync(path, '{"type":"user"}\n{"type":"custom-title"}\n');

  const readMatchingLines = makeGuestMatchingLinesReader({ runCommand: runLocalCommand }, 'host-1');

  const lines = await readMatchingLines(path, 'custom-title');

  expect(lines).toStrictEqual(['{"type":"custom-title"}']);
});

test('it reads nothing from a file the host does not hold', async () => {
  const ctx = setupTest();
  const readMatchingLines = makeGuestMatchingLinesReader({ runCommand: runLocalCommand }, 'host-1');

  const lines = await readMatchingLines(join(ctx.directory, 'missing.jsonl'), '');

  expect(lines).toBeNull();
});

test('it runs the read on the session host', async () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 'a-1.jsonl');
  const runCommand = mock(runLocalCommand);

  writeFileSync(path, '{"type":"user"}\n');

  const readMatchingLines = makeGuestMatchingLinesReader({ runCommand }, 'host-1');

  await readMatchingLines(path, '');

  expect(runCommand).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ host: 'host-1' }));
});

test('it reads nothing when the host refuses the command', async () => {
  const readMatchingLines = makeGuestMatchingLinesReader(
    { runCommand: () => Promise.reject(new Error('the host is asleep')) },
    'host-1',
  );

  const lines = await readMatchingLines('/tmp/atc/sessions/s-1/a-1.jsonl', '');

  expect(lines).toBeNull();
});
