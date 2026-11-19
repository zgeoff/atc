import { expect, jest, onTestFinished, test } from 'bun:test';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/core/test-utils/setup-temp-dir';
import { waitFor } from '@atc/core/test-utils/wait-for';
import { createStderrSink } from './create-stderr-sink';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-stderr-sink-');
  const outputPath = join(temporaryDirectory.path, 'stderr');
  const fd = openSync(outputPath, 'w');

  onTestFinished(() => {
    closeSync(fd);
  });

  jest.useFakeTimers();

  onTestFinished(() => {
    jest.useRealTimers();
  });

  return { fd, outputPath, sink: createStderrSink(fd) };
}

test('it writes each record as one line and leaves the descriptor open when it is disposed', async () => {
  const ctx = setupTest();

  for (const line of [
    'atc tcp event=listening host=127.0.0.1 port=8415',
    'atc tcp event=handshake_refused peer=100.64.0.7 reason=unauthorized count=1',
    'atc tcp event=refused peer=overflow count=1',
  ]) {
    ctx.sink({
      category: ['atc', 'tcp'],
      level: 'info',
      message: ['', line, ''],
      rawMessage: '{line}',
      timestamp: 0,
      properties: { line },
    });
  }

  await ctx.sink[Symbol.asyncDispose]();

  expect(readFileSync(ctx.outputPath, 'utf8')).toBe(
    [
      'atc tcp event=listening host=127.0.0.1 port=8415\n',
      'atc tcp event=handshake_refused peer=100.64.0.7 reason=unauthorized count=1\n',
      'atc tcp event=refused peer=overflow count=1\n',
    ].join(''),
  );
});

test('it starts the next write with one dropped line that counts the records it dropped', async () => {
  const ctx = setupTest();

  for (let count = 1; count <= 1541; count++) {
    const line = `atc tcp event=handshake_refused peer=127.0.0.1 reason=unexpected_line count=${String(count)}`;

    ctx.sink({
      category: ['atc', 'tcp'],
      level: 'info',
      message: ['', line, ''],
      rawMessage: '{line}',
      timestamp: 0,
      properties: { line },
    });
  }

  // Fake timers stop Bun.sleep, so the wait yields to the event loop instead.
  await waitFor(
    () => {
      expect(readFileSync(ctx.outputPath, 'utf8').split('\n')).toHaveLength(513);
    },
    {
      wait: () =>
        new Promise((resolve) => {
          setImmediate(resolve);
        }),
    },
  );

  // LogTape reports the drops of each interval once it ends.
  jest.advanceTimersByTime(100);

  await ctx.sink[Symbol.asyncDispose]();

  expect(readFileSync(ctx.outputPath, 'utf8')).toBe(
    [
      ...Array.from(
        { length: 512 },
        (_, index) =>
          `atc tcp event=handshake_refused peer=127.0.0.1 reason=unexpected_line count=${String(index + 1)}\n`,
      ),
      'atc log dropped=5\n',
      ...Array.from(
        { length: 1024 },
        (_, index) =>
          `atc tcp event=handshake_refused peer=127.0.0.1 reason=unexpected_line count=${String(index + 518)}\n`,
      ),
    ].join(''),
  );
});

test('it writes the dropped line last when it drops records that no later write follows', async () => {
  const ctx = setupTest();

  for (let count = 1; count <= 1541; count++) {
    const line = `atc tcp event=handshake_refused peer=127.0.0.1 reason=unexpected_line count=${String(count)}`;

    ctx.sink({
      category: ['atc', 'tcp'],
      level: 'info',
      message: ['', line, ''],
      rawMessage: '{line}',
      timestamp: 0,
      properties: { line },
    });
  }

  await ctx.sink.drain();
  await ctx.sink[Symbol.asyncDispose]();

  expect(readFileSync(ctx.outputPath, 'utf8')).toBe(
    [
      ...Array.from(
        { length: 512 },
        (_, index) =>
          `atc tcp event=handshake_refused peer=127.0.0.1 reason=unexpected_line count=${String(index + 1)}\n`,
      ),
      ...Array.from(
        { length: 1024 },
        (_, index) =>
          `atc tcp event=handshake_refused peer=127.0.0.1 reason=unexpected_line count=${String(index + 518)}\n`,
      ),
      'atc log dropped=5\n',
    ].join(''),
  );
});

test('it holds a batch it is given in place of the default one', async () => {
  const ctx = setupTest();
  const sink = createStderrSink(ctx.fd, 4);

  for (let count = 1; count <= 13; count++) {
    const line = `atc tcp event=handshake_refused peer=127.0.0.1 reason=unexpected_line count=${String(count)}`;

    sink({
      category: ['atc', 'tcp'],
      level: 'info',
      message: ['', line, ''],
      rawMessage: '{line}',
      timestamp: 0,
      properties: { line },
    });
  }

  await waitFor(
    () => {
      expect(readFileSync(ctx.outputPath, 'utf8').split('\n')).toHaveLength(5);
    },
    {
      wait: () =>
        new Promise((resolve) => {
          setImmediate(resolve);
        }),
    },
  );

  jest.advanceTimersByTime(100);

  await sink[Symbol.asyncDispose]();

  expect(readFileSync(ctx.outputPath, 'utf8')).toBe(
    [
      ...[1, 2, 3, 4].map(
        (count) =>
          `atc tcp event=handshake_refused peer=127.0.0.1 reason=unexpected_line count=${String(count)}\n`,
      ),
      'atc log dropped=1\n',
      ...[6, 7, 8, 9, 10, 11, 12, 13].map(
        (count) =>
          `atc tcp event=handshake_refused peer=127.0.0.1 reason=unexpected_line count=${String(count)}\n`,
      ),
    ].join(''),
  );
});
