import { expect, test } from 'bun:test';
import type { HarnessSpec } from '@atc/plugin-api';
import { registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { buildStubHeldProvider } from './build-stub-held-provider';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-stub-held-provider-');

  return { directory: temporaryDirectory.path };
}

test('it records the host of each preparation in the order it began', () => {
  const stub = buildStubHeldProvider();

  void stub.provider.prepareHost({ host: 'h1', daemonID: 'd1' });
  void stub.provider.prepareHost({ host: 'h2', daemonID: 'd1' });
  expect(stub.prepares).toStrictEqual(['h1', 'h2']);
});

test('it finishes a held host preparation once its host is released', () => {
  const stub = buildStubHeldProvider();
  const preparing = stub.provider.prepareHost({ host: 'h1', daemonID: 'd1' });

  stub.release('h1');

  expect(preparing).resolves.toBeUndefined();
});

test('it holds the preparation of a host not yet released after an earlier one finishes', async () => {
  const stub = buildStubHeldProvider();
  const second = stub.provider.prepareHost({ host: 'h2', daemonID: 'd1' });
  const first = stub.provider.prepareHost({ host: 'h1', daemonID: 'd1' });

  stub.release('h1');

  await first;

  expect(Bun.peek.status(second)).toBe('pending');
});

test('it records each harness it starts', () => {
  const ctx = setupTest();
  const stub = buildStubHeldProvider();

  const spec: HarnessSpec = {
    session: 's1',
    host: 's1',
    bin: 'true',
    args: [],
    cwd: ctx.directory,
    env: {},
    cols: 80,
    rows: 24,
  };

  const harness = stub.provider.spawnHarness(spec);

  registerTestCleanup(() => {
    harness.kill();
  });

  expect(stub.harnesses).toStrictEqual([spec]);
});
