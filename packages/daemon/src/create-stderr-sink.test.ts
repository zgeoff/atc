import { expect, jest, onTestFinished, test } from 'bun:test';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils';
import { createStderrSink } from './create-stderr-sink';

/**
 * A sink over a file in a fresh directory, which `outputPath` holds, with
 * LogTape's timers faked, so a test decides when the sink reports the
 * records it dropped.
 */
function setupTest() {
  const tmp = setupTempDir('atc-stderr-sink-');
  const outputPath = join(tmp.dir, 'stderr');
  const fd = openSync(outputPath, 'w');

  onTestFinished(() => {
    closeSync(fd);
  });

  jest.useFakeTimers();

  onTestFinished(() => {
    jest.useRealTimers();
  });

  return { outputPath, sink: createStderrSink(fd) };
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

// The sink starts to write once it holds 512 records and then holds 1024
// more at most, so a burst of 1541 records drops the 5 oldest it holds,
// the 513th to the 517th, before any write finishes.
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

  // LogTape reports the drops of each interval once it ends.
  jest.advanceTimersByTime(100);

  await ctx.sink[Symbol.asyncDispose]();

  expect(readFileSync(ctx.outputPath, 'utf8')).toBe(
    [
      'atc log dropped=5\n',
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

  // Every record it kept is written before the interval ends, so only the
  // disposal reports the drops.
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
