import { expect, onTestFinished, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendReport } from '../shared/report';
import { registerTestCleanup } from './register-test-cleanup';
import { setupTempDir } from './setup-temp-dir';
import { startStubReporterSocket } from './start-stub-reporter-socket';
import { waitFor } from './wait-for';

// A temp directory to hold the reporter's socket.
function setupTest() {
  const tmp = setupTempDir('atc-stub-reporter-');

  return { path: join(tmp.dir, 'reporter.sock') };
}

test('it collects each line a sender writes without its newline', async () => {
  const ctx = setupTest();
  const reporter = startStubReporterSocket(ctx.path);

  await sendReport(ctx.path, 'one\ntwo\n', 2000);

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

  await sendReport(ctx.path, 'unfinished', 2000);
  await sendReport(ctx.path, 'done\n', 2000);

  await waitFor(() => {
    expect(reporter.lines).toStrictEqual(['done']);
  });
});

test('it resolves the wait with the first line to arrive', async () => {
  const ctx = setupTest();
  const reporter = startStubReporterSocket(ctx.path);

  await sendReport(ctx.path, 'first\n', 2000);
  await sendReport(ctx.path, 'second\n', 2000);

  const line = await reporter.waitForLine();

  expect(line).toBe('first');
});

test('it rejects the wait naming the socket when no line arrives in time', () => {
  const ctx = setupTest();
  const reporter = startStubReporterSocket(ctx.path);

  expect(reporter.waitForLine(50)).rejects.toThrowWithMessage(
    Error,
    `no line has arrived at ${ctx.path}`,
  );
});

test('it stops listening once stopped', () => {
  const ctx = setupTest();

  startStubReporterSocket(ctx.path).stop();

  expect(Bun.connect({ unix: ctx.path, socket: { data() {} } })).rejects.toThrow();
});

test('it stops listening once the test finishes without a stop', () => {
  // The socket sits outside any directory the test removes, so only the
  // listener's own stop takes it away.
  const path = join(tmpdir(), `atc-stub-reporter-${randomUUID()}.sock`);
  let left: boolean | null = null;

  // Runs after the helper's own release, which registers later; it
  // records whether that release left the socket, then removes it.
  registerTestCleanup(() => {
    left = existsSync(path);

    rmSync(path, { force: true });
  });

  startStubReporterSocket(path);

  onTestFinished(() => {
    expect(left).toBeFalse();
  });
});
