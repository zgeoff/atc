import { expect, onTestFinished, test } from 'bun:test';
import type { HarnessSpec } from '../daemon/execution-provider';
import { buildStubHeldProvider } from './build-stub-held-provider';

test('it holds a host preparation until its host is released', () => {
  const stub = buildStubHeldProvider();
  const preparing = stub.provider.prepareHost({ host: 'h1', daemonID: 'd1' });

  expect({ prepares: stub.prepares, state: Bun.peek.status(preparing) }).toStrictEqual({
    prepares: ['h1'],
    state: 'pending',
  });
});

test('it finishes a held host preparation once its host is released', async () => {
  const stub = buildStubHeldProvider();
  const preparing = stub.provider.prepareHost({ host: 'h1', daemonID: 'd1' });

  stub.release('h1');

  const settled = await Promise.allSettled([preparing]);

  expect(settled).toStrictEqual([{ status: 'fulfilled', value: undefined }]);
});

test('it keeps holding the preparation of a host not yet released', () => {
  const stub = buildStubHeldProvider();

  void stub.provider.prepareHost({ host: 'h1', daemonID: 'd1' });
  const second = stub.provider.prepareHost({ host: 'h2', daemonID: 'd1' });

  stub.release('h1');

  expect(Bun.peek.status(second)).toBe('pending');
});

test('it records each harness it starts', () => {
  const stub = buildStubHeldProvider();

  const spec: HarnessSpec = {
    session: 's1',
    host: 's1',
    bin: 'true',
    args: [],
    cwd: '/',
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
