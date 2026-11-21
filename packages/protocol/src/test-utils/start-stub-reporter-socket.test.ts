import { expect, onTestFinished, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTestCleanup, waitFor } from '@zgeoff/testing';
import { createTempDir } from '@zgeoff/testing/fs';
import { startStubReporterSocket } from './start-stub-reporter-socket';

function setupTest() {
  const temporaryDirectory = createTempDir('atc-stub-reporter-');

  return { path: join(temporaryDirectory.path, 'reporter.sock') };
}

test('it collects each line a sender writes without its newline', async () => {
  const ctx = setupTest();
  const reporter = startStubReporterSocket(ctx.path);

  await Bun.connect({
    unix: ctx.path,
    socket: {
      open(socket) {
        socket.end('one\ntwo\n');
      },
      data() {},
    },
  });

  await waitFor(() => {
    expect(reporter.lines).toStrictEqual(['one', 'two']);
  });
});

test('it joins a line that arrives across several writes', async () => {
  const ctx = setupTest();
  const reporter = startStubReporterSocket(ctx.path);

  const socket = await Bun.connect({ unix: ctx.path, socket: { data() {} } });

  registerTestCleanup(() => {
    socket.end();
  });

  socket.write('{"par');

  await waitFor(() => {
    expect(reporter.reads).toBe(1);
  });

  socket.write('tial":1}\n');

  await waitFor(() => {
    expect(reporter.lines).toStrictEqual(['{"partial":1}']);
  });
});

test('it counts each read it takes from a connection', async () => {
  const ctx = setupTest();
  const reporter = startStubReporterSocket(ctx.path);

  const socket = await Bun.connect({ unix: ctx.path, socket: { data() {} } });

  registerTestCleanup(() => {
    socket.end();
  });

  socket.write('{"par');

  await waitFor(() => {
    expect(reporter.reads).toBe(1);
  });
});

test('it collects nothing from a line that never ends', async () => {
  const ctx = setupTest();
  const reporter = startStubReporterSocket(ctx.path);

  await Bun.connect({
    unix: ctx.path,
    socket: {
      open(socket) {
        socket.end('unfinished');
      },
      data() {},
    },
  });

  await waitFor(() => {
    expect(reporter.reads).toBe(1);
  });

  await Bun.connect({
    unix: ctx.path,
    socket: {
      open(socket) {
        socket.end('done\n');
      },
      data() {},
    },
  });

  await waitFor(() => {
    expect(reporter.lines).toStrictEqual(['done']);
  });
});

test('it resolves the wait with the first line to arrive', async () => {
  const ctx = setupTest();
  const reporter = startStubReporterSocket(ctx.path);

  await Bun.connect({
    unix: ctx.path,
    socket: {
      open(socket) {
        socket.end('first\nsecond\n');
      },
      data() {},
    },
  });

  const line = await reporter.waitForLine();

  expect(line).toBe('first');
});

test('it rejects the wait naming the socket when no line arrives in time', () => {
  const ctx = setupTest();
  const reporter = startStubReporterSocket(ctx.path);

  expect(reporter.waitForLine(50)).rejects.toThrowWithMessage(
    Error,
    `timed out after 50 ms: no line has arrived at ${ctx.path}`,
  );
});

test('it stops listening once stopped', () => {
  const ctx = setupTest();

  startStubReporterSocket(ctx.path).stop();

  expect(Bun.connect({ unix: ctx.path, socket: { data() {} } })).rejects.toThrow();
});

test('it stops listening once the test finishes without a stop', () => {
  const path = join(tmpdir(), `atc-stub-reporter-${randomUUID()}.sock`);
  let left: boolean | null = null;

  registerTestCleanup(() => {
    left = existsSync(path);

    rmSync(path, { force: true });
  });

  startStubReporterSocket(path);

  onTestFinished(() => {
    expect(left).toBeFalse();
  });
});
