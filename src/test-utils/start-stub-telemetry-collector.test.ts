import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { registerTestCleanup } from './register-test-cleanup';
import { setupTempDir } from './setup-temp-dir';
import { startStubTelemetryCollector } from './start-stub-telemetry-collector';

test('it receives the telemetry better-auth sends to the endpoint the environment sets', async () => {
  // A home for the telemetry process, so better-auth reads and writes no
  // file of the test run's own home.
  const home = setupTempDir('atc-telemetry-collector-');
  const collector = startStubTelemetryCollector();

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
        HOME: home.dir,
        NODE_ENV: 'production',
        BETTER_AUTH_TELEMETRY: '1',
        BETTER_AUTH_TELEMETRY_ENDPOINT: collector.url,
      },
      stderr: 'pipe',
    },
  );

  registerTestCleanup(() => {
    sent.kill();
  });

  const exitCode = await sent.exited;

  expect(exitCode).toBe(0);
  expect(collector.received).toStrictEqual([collector.url]);
});

test('it answers each request with no content', async () => {
  const collector = startStubTelemetryCollector();

  const answered = await fetch(collector.url, { method: 'POST', body: '{}' });

  expect(answered.status).toBe(204);
  expect(collector.received).toStrictEqual([collector.url]);
});

test('it stops serving once stopped', async () => {
  const collector = startStubTelemetryCollector();

  await collector.stop();

  expect(fetch(collector.url)).rejects.toThrow();
});

test('it stops serving once the test finishes without a stop', () => {
  const collector = startStubTelemetryCollector();

  onTestFinished(() => {
    expect(fetch(collector.url)).rejects.toThrow();
  });
});
