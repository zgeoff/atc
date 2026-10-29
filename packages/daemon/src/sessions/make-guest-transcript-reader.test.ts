import { expect, mock, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runLocalCommand, setupTempDir } from '@atc/test-utils';
import { makeGuestTranscriptReader } from './make-guest-transcript-reader';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-guest-transcript-');

  return { directory: temporaryDirectory.path };
}

test('it reads the size and the bytes of a window from an offset', async () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 'a-1.jsonl');

  writeFileSync(path, 'first turn\nsecond turn\n');

  const readWindow = makeGuestTranscriptReader({ runCommand: runLocalCommand }, 'host-1');

  const window = await readWindow(path, 11, 6);

  expect(window).toStrictEqual({ size: 23, bytes: Buffer.from('second') });
});

test('it reads a window that splits a character as its exact bytes', async () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 'a-1.jsonl');

  writeFileSync(path, 'café\n');

  const readWindow = makeGuestTranscriptReader({ runCommand: runLocalCommand }, 'host-1');

  const window = await readWindow(path, 0, 4);

  expect(window).toStrictEqual({ size: 6, bytes: Buffer.from([0x63, 0x61, 0x66, 0xc3]) });
});

test('it reads no bytes from an offset past the end of the file', async () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 'a-1.jsonl');

  writeFileSync(path, 'first turn\n');

  const readWindow = makeGuestTranscriptReader({ runCommand: runLocalCommand }, 'host-1');

  const window = await readWindow(path, 500, 1_048_576);

  expect(window).toStrictEqual({ size: 11, bytes: Buffer.from('') });
});

test('it reads no window when the host holds no file at the path', async () => {
  const ctx = setupTest();
  const readWindow = makeGuestTranscriptReader({ runCommand: runLocalCommand }, 'host-1');

  const window = await readWindow(join(ctx.directory, 'missing.jsonl'), 0, 1_048_576);

  expect(window).toBeNull();
});

test('it runs the read on the session host', async () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 'a-1.jsonl');
  const runCommand = mock(runLocalCommand);

  writeFileSync(path, 'first turn\n');

  const readWindow = makeGuestTranscriptReader({ runCommand }, 'host-1');

  await readWindow(path, 0, 1_048_576);

  expect(runCommand).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ host: 'host-1' }));
});

test('it rejects a read whose output is not a window', () => {
  const readWindow = makeGuestTranscriptReader(
    { runCommand: () => Promise.resolve({ exitCode: 0, stdout: 'first turn\n', stderr: '' }) },
    'host-1',
  );

  expect(readWindow('/tmp/atc/sessions/s-1/a-1.jsonl', 0, 1_048_576)).rejects.toThrowWithMessage(
    Error,
    'reading /tmp/atc/sessions/s-1/a-1.jsonl on host host-1 failed: ',
  );
});

test('it rejects a read that fails on the host', () => {
  const readWindow = makeGuestTranscriptReader(
    {
      runCommand: () =>
        Promise.resolve({ exitCode: 1, stdout: '', stderr: 'wc: Permission denied\n' }),
    },
    'host-1',
  );

  expect(readWindow('/tmp/atc/sessions/s-1/a-1.jsonl', 0, 1_048_576)).rejects.toThrowWithMessage(
    Error,
    'reading /tmp/atc/sessions/s-1/a-1.jsonl on host host-1 failed: wc: Permission denied',
  );
});
