import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { setupTempDir } from './setup-temp-dir';
import { startStubTelemetryCollector } from './start-stub-telemetry-collector';

// A home for the telemetry process, so better-auth reads and writes no file
// of the test run's own home, and the collector it reports to.
function setupTest() {
  using stack = new DisposableStack();

  const tmp = stack.use(setupTempDir('atc-telemetry-collector-'));
  const collector = startStubTelemetryCollector();
  const owned = stack.move();

  return {
    dir: tmp.dir,
    collector,
    [Symbol.asyncDispose]: async () => {
      await collector[Symbol.asyncDispose]();

      owned.dispose();
    },
  };
}

test('it receives the telemetry better-auth sends to the endpoint the environment sets', async () => {
  await using ctx = setupTest();

  // A production-mode process, since better-auth never sends telemetry under
  // NODE_ENV=test. A request it starts keeps the process alive until the
  // collector answers, so the process exits only after the request arrived.
  const sent = Bun.spawn(
    [
      process.execPath,
      '-e',
      `const { createTelemetry } = await import('better-auth');
await createTelemetry({ baseURL: 'http://127.0.0.1' });`,
    ],
    {
      cwd: join(import.meta.dir, '..', '..'),
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: ctx.dir,
        NODE_ENV: 'production',
        BETTER_AUTH_TELEMETRY: '1',
        BETTER_AUTH_TELEMETRY_ENDPOINT: ctx.collector.url,
      },
      stderr: 'pipe',
    },
  );

  const exitCode = await sent.exited;

  expect({ exitCode, received: ctx.collector.received }).toStrictEqual({
    exitCode: 0,
    received: [ctx.collector.url],
  });
});

test('it answers each request with no content', async () => {
  await using ctx = setupTest();

  const answered = await fetch(ctx.collector.url, { method: 'POST', body: '{}' });

  expect({ status: answered.status, received: ctx.collector.received }).toStrictEqual({
    status: 204,
    received: [ctx.collector.url],
  });
});

test('it stops serving once disposed', async () => {
  const collector = startStubTelemetryCollector();

  await collector[Symbol.asyncDispose]();

  expect(fetch(collector.url)).rejects.toThrow();
});
