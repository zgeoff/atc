import { expect, test } from 'bun:test';
import { CredentialBrokerError } from '@atc/plugin-api';
import { buildStubCredentialBroker } from './build-stub-credential-broker';

test('it names each host under its prefix', () => {
  expect(buildStubCredentialBroker('harness-').getHostName('s1')).toBe('harness-s1');
});

test('it gives a host made again under the same name a new id', async () => {
  const broker = buildStubCredentialBroker();

  const first = await broker.createHost('s1');

  await broker.destroyHost('s1');

  const second = await broker.createHost('s1');

  expect(second.name).toBe(first.name);
  expect(second.id).not.toBe(first.id);
});

test('it reads a host it holds by name', async () => {
  const broker = buildStubCredentialBroker();

  const created = await broker.createHost('s1');
  const read = await broker.readHost('atc-s1');

  expect(read).toStrictEqual(created);
});

test('it reads no host for a name it does not hold', async () => {
  const broker = buildStubCredentialBroker();

  await broker.createHost('s1');

  const read = await broker.readHost('atc-s2');

  expect(read).toBeNull();
});

test('it refuses to create a host under a name it already holds', async () => {
  const broker = buildStubCredentialBroker();

  await broker.createHost('s1');

  expect(broker.createHost('s1')).rejects.toMatchObject({
    code: 'refused',
    brokerCode: 'CONFLICT',
  });
});

test('it resolves the removal of a grant the host no longer holds as false', async () => {
  const broker = buildStubCredentialBroker();

  broker.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  await broker.createHost('s1');
  await broker.createGrant('atc-s1', 'glm');

  const first = await broker.removeGrant('atc-s1', 'glm');
  const second = await broker.removeGrant('atc-s1', 'glm');
  const grants = await broker.readGrants('atc-s1');

  expect(first).toBeTrue();
  expect(second).toBeFalse();
  expect(grants).toStrictEqual([]);
});

test('it keeps one grant when the same secret is granted twice', async () => {
  const broker = buildStubCredentialBroker();

  broker.createSecret('glm', 'custom', []);

  await broker.createHost('s1');
  await broker.createGrant('atc-s1', 'glm');
  await broker.createGrant('atc-s1', 'glm');

  const grants = await broker.readGrants('atc-s1');

  expect(grants).toStrictEqual(['glm']);
});

test('it rejects a grant call on a missing host with a broker error', () => {
  const broker = buildStubCredentialBroker();

  broker.createSecret('glm', 'custom', []);

  expect(broker.removeGrant('atc-s1', 'glm')).rejects.toBeInstanceOf(CredentialBrokerError);
});

test('it rejects a grant removal on a missing host as not found', () => {
  const broker = buildStubCredentialBroker();

  broker.createSecret('glm', 'custom', []);

  expect(broker.removeGrant('atc-s1', 'glm')).rejects.toMatchObject({
    code: 'not_found',
    brokerCode: 'NOT_FOUND',
  });
});

test('it rejects a grant of a missing secret as not found', async () => {
  const broker = buildStubCredentialBroker();

  await broker.createHost('s1');

  expect(broker.createGrant('atc-s1', 'glm')).rejects.toMatchObject({ code: 'not_found' });
});

test('it resolves the destroy of a host it does not hold', async () => {
  const broker = buildStubCredentialBroker();

  await expect(broker.destroyHost('s1')).toResolve();
});

test('it drops every grant of a secret that is rebound', async () => {
  const broker = buildStubCredentialBroker();

  broker.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  await broker.createHost('s1');
  await broker.createGrant('atc-s1', 'glm');

  broker.updateSecret('glm', [{ host: 'api.z.ai', header: 'x-api-key', scheme: 'raw' }]);

  const grants = await broker.readGrants('atc-s1');
  const secrets = await broker.readSecrets();

  expect(grants).toStrictEqual([]);

  expect(secrets).toStrictEqual([
    {
      name: 'glm',
      kind: 'custom',
      rules: [{ host: 'api.z.ai', header: 'x-api-key', scheme: 'raw' }],
    },
  ]);
});

test('it drops every grant of a secret that is removed', async () => {
  const broker = buildStubCredentialBroker();

  broker.createSecret('glm', 'custom', []);

  await broker.createHost('s1');
  await broker.createGrant('atc-s1', 'glm');

  broker.removeSecret('glm');

  const grants = await broker.readGrants('atc-s1');
  const secrets = await broker.readSecrets();

  expect(grants).toStrictEqual([]);
  expect(secrets).toStrictEqual([]);
});

test('it starts passing the version check', async () => {
  await expect(buildStubCredentialBroker().verifyVersion()).toResolve();
});

test('it starts with an identity that manages its own hosts', async () => {
  const identity = await buildStubCredentialBroker('harness-').readIdentity();

  expect(identity).toStrictEqual({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['harness-*'],
    grantable: [],
  });
});

test('it refuses the version check as outdated once a test marks it so', () => {
  const broker = buildStubCredentialBroker();

  broker.setOutdated(true);

  expect(broker.verifyVersion()).rejects.toMatchObject({
    code: 'refused',
    brokerCode: 'IMPD_OUTDATED',
  });
});

test('it answers with the identity a test sets', async () => {
  const broker = buildStubCredentialBroker();

  broker.setIdentity({ name: 'other', scope: 'read', hosts: null, grantable: ['glm'] });

  const identity = await broker.readIdentity();

  expect(identity).toStrictEqual({ name: 'other', scope: 'read', hosts: null, grantable: ['glm'] });
});

test('it records each contract call in order', async () => {
  const broker = buildStubCredentialBroker();

  broker.createSecret('glm', 'custom', []);

  await broker.readIdentity();
  await broker.createHost('s1');
  await broker.createGrant('atc-s1', 'glm');
  await broker.destroyHost('s1');

  expect(broker.calls).toStrictEqual([
    'readIdentity',
    'createHost atc-s1',
    'createGrant atc-s1 glm',
    'destroyHost atc-s1',
  ]);
});

test('it lists the sign-in state of a secret created with one', async () => {
  const broker = buildStubCredentialBroker();

  broker.createSecret(
    'codex-chatgpt',
    'oauth',
    [{ host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' }],
    { status: 'ready', idClaims: { email: 'someone@example.com' } },
  );

  broker.createSecret('glm', 'custom', []);

  const secrets = await broker.readSecrets();

  expect(secrets).toStrictEqual([
    {
      name: 'codex-chatgpt',
      kind: 'oauth',
      rules: [{ host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' }],
      oauth: { status: 'ready', idClaims: { email: 'someone@example.com' } },
    },
    { name: 'glm', kind: 'custom', rules: [] },
  ]);
});

test('it fails the set number of version checks as an unreachable broker, then passes', async () => {
  const broker = buildStubCredentialBroker();

  broker.setVersionFailures(1);

  const failed = broker.verifyVersion();

  expect(failed).rejects.toMatchObject({ code: 'unreachable', brokerCode: 'UNREACHABLE' });

  await failed.catch(() => {});

  await expect(broker.verifyVersion()).toResolve();
});
