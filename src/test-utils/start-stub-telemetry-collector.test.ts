import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { setupTempDir } from './setup-temp-dir';
import { startStubTelemetryCollector } from './start-stub-telemetry-collector';

// A home for the telemetry process, so better-auth reads and writes no file
// of the test run's own home, and the collector it reports to.
// oxlint-disable-next-line require-await -- the await is the `await using` declaration that releases the stack when a later setup step throws
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const tmp = stack.use(setupTempDir('atc-telemetry-collector-'));
  const collector = stack.use(startStubTelemetryCollector());
  const owned = stack.move();

  return {
    dir: tmp.dir,
    collector,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it receives the telemetry better-auth sends to the endpoint the environment sets', async () => {
  await using ctx = await setupTest();

  // A production-mode process, since better-auth never sends telemetry under
  // NODE_ENV=test. A request it starts keeps the process alive until the
  // collector answers, so the process exits only after the request arrived.
  await using sent = Bun.spawn(
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
  await using ctx = await setupTest();

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
