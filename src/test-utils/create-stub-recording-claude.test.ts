import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStubRecordingClaude } from './create-stub-recording-claude';
import { registerTestCleanup } from './register-test-cleanup';
import { setupTempDir } from './setup-temp-dir';
import { waitFor } from './wait-for';

function setupTest() {
  const tmp = setupTempDir('atc-stub-recording-claude-');

  return { dir: tmp.dir };
}

test('it returns the path of the stub under the directory', () => {
  const ctx = setupTest();

  expect(createStubRecordingClaude(ctx.dir)).toBe(join(ctx.dir, 'fake-claude'));
});

test('it writes no start log before it runs', () => {
  const ctx = setupTest();

  createStubRecordingClaude(ctx.dir);

  expect(existsSync(join(ctx.dir, 'claude-starts.log'))).toBeFalse();
});

test('it records the arguments of a start one per line, then an empty line', async () => {
  const ctx = setupTest();
  const bin = createStubRecordingClaude(ctx.dir);
  const run = Bun.spawn([bin, '--a', 'two words']);

  registerTestCleanup(() => {
    run.kill();
  });

  await waitFor(() => {
    expect(readFileSync(join(ctx.dir, 'claude-starts.log'), 'utf8')).toBe('--a\ntwo words\n\n');
  });
});

test('it appends a later start after an earlier one', async () => {
  const ctx = setupTest();
  const bin = createStubRecordingClaude(ctx.dir);
  const log = join(ctx.dir, 'claude-starts.log');
  const first = Bun.spawn([bin, '--a']);

  registerTestCleanup(() => {
    first.kill();
  });

  await waitFor(() => {
    expect(readFileSync(log, 'utf8')).toEndWith('\n\n');
  });

  const second = Bun.spawn([bin, '--b']);

  registerTestCleanup(() => {
    second.kill();
  });

  await waitFor(() => {
    expect(readFileSync(log, 'utf8')).toBe('--a\n\n--b\n\n');
  });
});

test('it is still running after it records its start', async () => {
  const ctx = setupTest();
  const bin = createStubRecordingClaude(ctx.dir);
  const run = Bun.spawn([bin]);

  registerTestCleanup(() => {
    run.kill();
  });

  await waitFor(() => {
    expect(existsSync(join(ctx.dir, 'claude-starts.log'))).toBeTrue();
  });

  run.kill();

  await run.exited;

  expect(run.signalCode).toBe('SIGTERM');
});
