import { expect, test } from 'bun:test';
import { registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { buildStubSoftKillProvider } from './build-stub-soft-kill-provider';

function setupTest() {
  const tmp = setupTempDir('atc-soft-kill-');

  return { dir: tmp.dir };
}

test('it declares the capabilities of a local terminal', () => {
  expect(buildStubSoftKillProvider().capabilities).toStrictEqual({
    spawn: true,
    attach: true,
    input: true,
    resize: true,
    kill: true,
    transfer: true,
    run: true,
    headless: true,
    suspend: false,
    destroy: false,
  });
});

test('it starts a harness that has no forced kill', () => {
  const ctx = setupTest();

  const harness = buildStubSoftKillProvider().spawnHarness({
    session: 's-1',
    host: 's-1',
    bin: 'sleep',
    args: ['30'],
    cwd: ctx.dir,
    env: {},
    cols: 80,
    rows: 24,
  });

  registerTestCleanup(() => {
    harness.kill();
  });

  expect(harness.killForced).toBeUndefined();
});
