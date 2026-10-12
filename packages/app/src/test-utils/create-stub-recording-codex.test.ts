import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStubRecordingCodex } from './create-stub-recording-codex';
import { registerTestCleanup } from './register-test-cleanup';
import { setupTempDir } from './setup-temp-dir';
import { waitFor } from './wait-for';

function setupTest() {
  const tmp = setupTempDir('atc-stub-recording-codex-');

  return { dir: tmp.dir };
}

test('it returns the path of the stub under the directory', () => {
  const ctx = setupTest();

  expect(createStubRecordingCodex(ctx.dir)).toBe(join(ctx.dir, 'fake-codex'));
});

test('it writes no start log before it runs', () => {
  const ctx = setupTest();

  createStubRecordingCodex(ctx.dir);

  expect(existsSync(join(ctx.dir, 'codex-starts.log'))).toBeFalse();
});

test('it records its Codex home and arguments on one line for a start', async () => {
  const ctx = setupTest();
  const bin = createStubRecordingCodex(ctx.dir);

  const run = Bun.spawn([bin, '--a', 'two words'], {
    env: { ...process.env, CODEX_HOME: '/codex/home' },
  });

  registerTestCleanup(() => {
    run.kill();
  });

  await waitFor(() => {
    expect(readFileSync(join(ctx.dir, 'codex-starts.log'), 'utf8')).toBe(
      '/codex/home --a two words\n',
    );
  });
});

test('it appends a later start after an earlier one', async () => {
  const ctx = setupTest();
  const bin = createStubRecordingCodex(ctx.dir);
  const log = join(ctx.dir, 'codex-starts.log');
  const first = Bun.spawn([bin, '--a'], { env: { ...process.env, CODEX_HOME: '/one' } });

  registerTestCleanup(() => {
    first.kill();
  });

  await waitFor(() => {
    expect(readFileSync(log, 'utf8')).toBe('/one --a\n');
  });

  const second = Bun.spawn([bin, '--b'], { env: { ...process.env, CODEX_HOME: '/two' } });

  registerTestCleanup(() => {
    second.kill();
  });

  await waitFor(() => {
    expect(readFileSync(log, 'utf8')).toBe('/one --a\n/two --b\n');
  });
});

test('it is still running after it records its start', async () => {
  const ctx = setupTest();
  const bin = createStubRecordingCodex(ctx.dir);
  const run = Bun.spawn([bin]);

  registerTestCleanup(() => {
    run.kill();
  });

  await waitFor(() => {
    expect(existsSync(join(ctx.dir, 'codex-starts.log'))).toBeTrue();
  });

  run.kill();

  await run.exited;

  expect(run.signalCode).toBe('SIGTERM');
});
