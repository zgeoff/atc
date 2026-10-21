import { expect, test } from 'bun:test';
import { registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { createStubSoftKillProvider } from './create-stub-soft-kill-provider';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-soft-kill-');

  return { directory: temporaryDirectory.path };
}

test('it declares the capabilities of a local terminal', () => {
  expect(createStubSoftKillProvider().capabilities).toStrictEqual({
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

  const harness = createStubSoftKillProvider().spawnHarness({
    session: 's-1',
    host: 's-1',
    bin: 'sleep',
    args: ['30'],
    cwd: ctx.directory,
    env: {},
    cols: 80,
    rows: 24,
  });

  registerTestCleanup(() => {
    harness.kill();
  });

  expect(harness.killForced).toBeUndefined();
});
