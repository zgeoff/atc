import { expect, test } from 'bun:test';
import { buildStubCredentialBroker } from './build-stub-credential-broker';
import { buildStubPregrantedBrokerHost } from './build-stub-pregranted-broker-host';

test('it creates a host that already holds a grant of the secret', async () => {
  const broker = buildStubCredentialBroker('atc-');

  broker.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const stub = buildStubPregrantedBrokerHost(broker, 'judge');

  const created = await stub.createHost('s1');
  const grants = await broker.readGrants('atc-s1');

  expect(created.name).toBe('atc-s1');
  expect(grants).toStrictEqual(['judge']);
});

test('it keeps every other member of the broker it wraps', () => {
  const broker = buildStubCredentialBroker('atc-');
  const stub = buildStubPregrantedBrokerHost(broker, 'judge');

  expect(stub).toStrictEqual({ ...broker, createHost: expect.toBeFunction() });
});
