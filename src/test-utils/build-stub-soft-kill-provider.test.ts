import { expect, onTestFinished, test } from 'bun:test';
import { buildStubSoftKillProvider } from './build-stub-soft-kill-provider';
import { setupTempDir } from './setup-temp-dir';

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
  using tmp = setupTempDir('atc-soft-kill-');

  const harness = buildStubSoftKillProvider().spawnHarness({
    session: 's-1',
    host: 's-1',
    bin: 'sleep',
    args: ['30'],
    cwd: tmp.dir,
    env: {},
    cols: 80,
    rows: 24,
  });

  onTestFinished(() => {
    harness.kill();
  });

  expect(harness.killForced).toBeUndefined();
});
