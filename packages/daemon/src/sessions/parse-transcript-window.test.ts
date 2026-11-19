import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStubBin } from '@atc/core/test-utils/create-stub-bin';
import { runCommand } from '@atc/core/test-utils/run-command';
import { setupTempDir } from '@atc/core/test-utils/setup-temp-dir';
import { buildTranscriptWindowArgs } from './build-transcript-window-args';
import { NO_TRANSCRIPT_CODE, READ_TRANSCRIPT_WINDOW_SCRIPT } from './constants';
import { parseTranscriptWindow } from './parse-transcript-window';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-transcript-window-');

  return { directory: temporaryDirectory.path };
}

test('it reads the exact bytes of a window that splits a character', async () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 'a-1.jsonl');

  writeFileSync(path, 'café\nsecond turn\n');

  const read = await runCommand([
    'sh',
    '-c',
    READ_TRANSCRIPT_WINDOW_SCRIPT,
    'sh',
    ...buildTranscriptWindowArgs(path, 3, 4),
  ]);

  expect(parseTranscriptWindow(read.stdout, 3, 4)).toStrictEqual({
    size: 18,
    bytes: Buffer.from([0xc3, 0xa9, 0x0a, 0x73]),
  });
});

test('it reads the exact bytes of a window across a block boundary', async () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 'a-1.jsonl');

  writeFileSync(path, `${'a'.repeat(65_530)}0123456789${'b'.repeat(4460)}`);

  const read = await runCommand([
    'sh',
    '-c',
    READ_TRANSCRIPT_WINDOW_SCRIPT,
    'sh',
    ...buildTranscriptWindowArgs(path, 65_530, 10),
  ]);

  expect(parseTranscriptWindow(read.stdout, 65_530, 10)).toStrictEqual({
    size: 70_000,
    bytes: Buffer.from('0123456789'),
  });
});

test('it reads an empty window from an offset past the end of the file', async () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 'a-1.jsonl');

  writeFileSync(path, 'first turn\n');

  const read = await runCommand([
    'sh',
    '-c',
    READ_TRANSCRIPT_WINDOW_SCRIPT,
    'sh',
    ...buildTranscriptWindowArgs(path, 500, 10),
  ]);

  expect(parseTranscriptWindow(read.stdout, 500, 10)).toStrictEqual({
    size: 11,
    bytes: Buffer.from(''),
  });
});

test('it exits with the missing-file code when there is no file at the path', async () => {
  const ctx = setupTest();

  const read = await runCommand([
    'sh',
    '-c',
    READ_TRANSCRIPT_WINDOW_SCRIPT,
    'sh',
    ...buildTranscriptWindowArgs(join(ctx.directory, 'missing.jsonl'), 0, 10),
  ]);

  expect(read.exitCode).toBe(NO_TRANSCRIPT_CODE);
});

test('it exits with a failure when the host cannot copy the bytes of the window', async () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 'a-1.jsonl');
  const bin = join(ctx.directory, 'bin');

  writeFileSync(path, 'first turn\n');
  createStubBin(bin, 'dd', '#!/bin/sh\nexit 1\n');
  createStubBin(bin, 'tail', '#!/bin/sh\nexit 1\n');

  const read = await runCommand(
    ['sh', '-c', READ_TRANSCRIPT_WINDOW_SCRIPT, 'sh', ...buildTranscriptWindowArgs(path, 0, 10)],
    { env: { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect(read.exitCode).toBe(1);
});

test('it parses blocks that base64 wrapped over several lines', () => {
  expect(parseTranscriptWindow('11\nZmlyc3Qg\ndHVybgo=\n', 0, 11)).toStrictEqual({
    size: 11,
    bytes: Buffer.from('first turn\n'),
  });
});

test('it parses no window from a response without the size line', () => {
  expect(parseTranscriptWindow('Zmlyc3Q=', 0, 5)).toBeNull();
});

test('it parses no window from a response whose blocks are not base64', () => {
  expect(parseTranscriptWindow('11\nfirst turn', 0, 10)).toBeNull();
});
