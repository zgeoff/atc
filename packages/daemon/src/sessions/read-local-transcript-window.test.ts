import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils';
import { readLocalTranscriptWindow } from './read-local-transcript-window';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-local-transcript-');

  return { directory: temporaryDirectory.path };
}

test('it reads the size and the bytes of a window from an offset', async () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 'a-1.jsonl');

  writeFileSync(path, 'first turn\nsecond turn\n');

  const window = await readLocalTranscriptWindow(path, 11, 6);

  expect(window).toStrictEqual({ size: 23, bytes: new Uint8Array(Buffer.from('second')) });
});

test('it reads no bytes from an offset past the end of the file', async () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 'a-1.jsonl');

  writeFileSync(path, 'first turn\n');

  const window = await readLocalTranscriptWindow(path, 500, 1_048_576);

  expect(window).toStrictEqual({ size: 11, bytes: new Uint8Array() });
});

test('it reads no window when there is no file at the path', async () => {
  const ctx = setupTest();

  const window = await readLocalTranscriptWindow(join(ctx.directory, 'missing.jsonl'), 0, 10);

  expect(window).toBeNull();
});
