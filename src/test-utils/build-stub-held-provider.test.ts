import { expect, onTestFinished, test } from 'bun:test';
import type { HarnessSpec } from '../daemon/execution-provider';
import { buildStubHeldProvider } from './build-stub-held-provider';
import { setupTempDir } from './setup-temp-dir';

function setupTest() {
  return setupTempDir('atc-stub-held-provider-');
}

test('it records the host of each preparation in the order it began', () => {
  const stub = buildStubHeldProvider();

  void stub.provider.prepareHost({ host: 'h1', daemonID: 'd1' });
  void stub.provider.prepareHost({ host: 'h2', daemonID: 'd1' });
  expect(stub.prepares).toStrictEqual(['h1', 'h2']);
});

test('it finishes a held host preparation once its host is released', async () => {
  const stub = buildStubHeldProvider();
  const preparing = stub.provider.prepareHost({ host: 'h1', daemonID: 'd1' });

  stub.release('h1');

  const settled = await Promise.allSettled([preparing]);

  expect(settled).toStrictEqual([{ status: 'fulfilled', value: undefined }]);
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
  using ctx = setupTest();

  const stub = buildStubHeldProvider();

  const spec: HarnessSpec = {
    session: 's1',
    host: 's1',
    bin: 'true',
    args: [],
    cwd: ctx.dir,
    env: {},
    cols: 80,
    rows: 24,
  };

  const harness = stub.provider.spawnHarness(spec);

  onTestFinished(() => {
    harness.kill();
  });

  expect(stub.harnesses).toStrictEqual([spec]);
});
