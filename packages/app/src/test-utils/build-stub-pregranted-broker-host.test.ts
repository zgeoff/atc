import { expect, test } from 'bun:test';
import { ImpProvider } from '../daemon/imp-provider';
import { buildStubPregrantedBrokerHost } from './build-stub-pregranted-broker-host';
import { createStubImpPort } from './create-stub-imp-port';
import { registerTestCleanup } from './register-test-cleanup';

function setupTest() {
  const port = createStubImpPort();

  const provider = new ImpProvider(port, {}, { atcBinary: null });

  registerTestCleanup(() => {
    provider.dispose();
  });

  return { port, host: provider.brokerAuth };
}

test('it creates an imp that already holds a grant of the secret', async () => {
  const ctx = setupTest();

  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['judge'],
  });

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const stub = buildStubPregrantedBrokerHost(ctx.host, 'judge');

  const imp = await stub.createImp('s1');
  const grants = await ctx.port.readGrants('atc-s1');

  expect(imp.name).toBe('atc-s1');
  expect(grants).toStrictEqual(['judge']);
});

test('it keeps every other member of the host it wraps', () => {
  const ctx = setupTest();
  const stub = buildStubPregrantedBrokerHost(ctx.host, 'judge');

  expect(stub).toStrictEqual({ ...ctx.host, createImp: expect.toBeFunction() });
});
