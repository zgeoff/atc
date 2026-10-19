import { expect, test } from 'bun:test';
import { buildStubBinderBroker } from './build-stub-binder-broker';

test('it names each host under its prefix', () => {
  expect(buildStubBinderBroker('harness-').getHostName('s1')).toBe('harness-s1');
});

test('it passes the version check until a test marks it outdated', async () => {
  await expect(buildStubBinderBroker().verifyVersion()).toResolve();
});

test('it refuses the version check as outdated once a test marks it so', () => {
  const broker = buildStubBinderBroker();

  broker.setOutdated(true);

  expect(broker.verifyVersion()).rejects.toMatchObject({
    code: 'refused',
    brokerCode: 'IMPD_OUTDATED',
  });
});

test('it gives a host made again under the same name a new id', async () => {
  const broker = buildStubBinderBroker();

  const first = await broker.createHost('s1');

  await broker.destroyHost('s1');

  const second = await broker.createHost('s1');

  expect(second.name).toBe(first.name);
  expect(second.id).not.toBe(first.id);
});

test('it refuses to create a host under a name it already holds', async () => {
  const broker = buildStubBinderBroker();

  await broker.createHost('s1');

  expect(broker.createHost('s1')).rejects.toMatchObject({
    code: 'refused',
    brokerCode: 'CONFLICT',
  });
});

test('it resolves the destroy of a host it does not hold', async () => {
  const broker = buildStubBinderBroker();

  await expect(broker.destroyHost('s1')).toResolve();
});

test('it reaches the same hosts through a broker with another prefix', async () => {
  const broker = buildStubBinderBroker('atc-');
  const renamed = broker.buildRenamedBroker('atc-new-');

  await broker.createHost('s1');
  await renamed.createHost('s1');
  await renamed.destroyHost('s1');

  expect(renamed.getHostName('s1')).toBe('atc-new-s1');
  expect(broker.collectHostNames()).toStrictEqual(['atc-s1']);
});

test('it records held calls as they arrive and answers none of them before a release', async () => {
  const broker = buildStubBinderBroker();

  broker.holdCalls();

  const created = broker.createHost('s1');
  const read = broker.readHost('atc-s1');

  const heldCalls = await broker.waitForHeldCalls(2);

  const heldHosts = broker.collectHostNames();

  broker.releaseCalls();

  await created;

  const host = await read;

  expect(heldCalls).toStrictEqual(['createHost atc-s1', 'readHost atc-s1']);
  expect(heldHosts).toStrictEqual([]);
  expect(host).toStrictEqual({ id: 'host-1', name: 'atc-s1' });
});

test('it lists the held calls without waiting for any', () => {
  const broker = buildStubBinderBroker();

  broker.holdCalls();
  void broker.verifyVersion();
  expect(broker.collectHeldCalls()).toStrictEqual(['verifyVersion']);
});

test('it answers calls at once again after a release', async () => {
  const broker = buildStubBinderBroker();

  broker.holdCalls();
  broker.releaseCalls();

  await broker.createHost('s1');

  expect(broker.collectHeldCalls()).toStrictEqual([]);
  expect(broker.collectHostNames()).toStrictEqual(['atc-s1']);
});

test('it records each contract call in order', async () => {
  const broker = buildStubBinderBroker();

  broker.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm'],
  });

  broker.createSecret('glm', 'custom', []);

  await broker.verifyVersion();
  await broker.readIdentity();
  await broker.readSecrets();
  await broker.readHost('atc-s1');
  await broker.createHost('s1');
  await broker.createGrant('atc-s1', 'glm');
  await broker.readGrants('atc-s1');
  await broker.removeGrant('atc-s1', 'glm');
  await broker.destroyHost('s1');

  expect(broker.calls).toStrictEqual([
    'verifyVersion',
    'readIdentity',
    'readSecrets',
    'readHost atc-s1',
    'createHost atc-s1',
    'createGrant atc-s1 glm',
    'readGrants atc-s1',
    'removeGrant atc-s1 glm',
    'destroyHost atc-s1',
  ]);
});

test('it refuses a grant from an identity without the manage scope', async () => {
  const broker = buildStubBinderBroker();

  broker.setIdentity({ name: 'atc-runtime', scope: 'exec', hosts: ['atc-*'], grantable: ['glm'] });
  broker.createSecret('glm', 'custom', []);

  await broker.createHost('s1');

  expect(broker.createGrant('atc-s1', 'glm')).rejects.toMatchObject({
    code: 'forbidden',
    brokerCode: 'FORBIDDEN',
    data: { reason: 'scope' },
  });
});

test('it refuses a grant on a host outside the identity patterns', async () => {
  const broker = buildStubBinderBroker();

  broker.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['other-*'],
    grantable: ['glm'],
  });

  broker.createSecret('glm', 'custom', []);

  await broker.createHost('s1');

  expect(broker.createGrant('atc-s1', 'glm')).rejects.toMatchObject({
    code: 'forbidden',
    data: { reason: 'imp_out_of_scope' },
  });
});

test('it refuses a grant of a secret the identity does not list as grantable', async () => {
  const broker = buildStubBinderBroker();

  broker.setIdentity({ name: 'atc-runtime', scope: 'manage', hosts: ['atc-*'], grantable: [] });
  broker.createSecret('glm', 'custom', []);

  await broker.createHost('s1');

  expect(broker.createGrant('atc-s1', 'glm')).rejects.toMatchObject({
    code: 'forbidden',
    data: { reason: 'not_grantable' },
  });
});

test('it grants any secret to an identity that reaches every host', async () => {
  const broker = buildStubBinderBroker();

  broker.setIdentity({ name: 'host-wide', scope: 'manage', hosts: null, grantable: [] });
  broker.createSecret('glm', 'custom', []);

  await broker.createHost('s1');
  await broker.createGrant('atc-s1', 'glm');

  const grants = await broker.readGrants('atc-s1');

  expect(grants).toStrictEqual(['glm']);
});

test('it drops the grants of a rebound secret and refuses it until the identity is set again', async () => {
  const broker = buildStubBinderBroker();

  broker.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm'],
  });

  broker.createSecret('glm', 'custom', []);

  await broker.createHost('s1');
  await broker.createGrant('atc-s1', 'glm');

  broker.updateSecret('glm', [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }]);

  const grants = await broker.readGrants('atc-s1');

  const refused = broker.createGrant('atc-s1', 'glm');

  expect(grants).toStrictEqual([]);
  expect(refused).rejects.toMatchObject({ code: 'forbidden', data: { reason: 'not_grantable' } });
});

test('it grants a rebound secret again once the identity is set again', async () => {
  const broker = buildStubBinderBroker();

  broker.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm'],
  });

  broker.createSecret('glm', 'custom', []);
  broker.updateSecret('glm', []);

  broker.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm'],
  });

  await broker.createHost('s1');
  await broker.createGrant('atc-s1', 'glm');

  const grants = await broker.readGrants('atc-s1');

  expect(grants).toStrictEqual(['glm']);
});

test('it drops the grants of a removed secret and refuses one made again under its name', async () => {
  const broker = buildStubBinderBroker();

  broker.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm'],
  });

  broker.createSecret('glm', 'custom', []);

  await broker.createHost('s1');
  await broker.createGrant('atc-s1', 'glm');

  broker.removeSecret('glm');
  broker.createSecret('glm', 'custom', []);

  const grants = await broker.readGrants('atc-s1');

  const refused = broker.createGrant('atc-s1', 'glm');

  expect(grants).toStrictEqual([]);
  expect(refused).rejects.toMatchObject({ code: 'forbidden', data: { reason: 'not_grantable' } });
});

test('it refuses a grant on a host it does not hold as not found', () => {
  const broker = buildStubBinderBroker();

  broker.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm'],
  });

  broker.createSecret('glm', 'custom', []);

  expect(broker.createGrant('atc-s1', 'glm')).rejects.toMatchObject({
    code: 'not_found',
    brokerCode: 'NOT_FOUND',
  });
});

test('it refuses a grant of a secret it does not hold as not found', async () => {
  const broker = buildStubBinderBroker();

  broker.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm'],
  });

  await broker.createHost('s1');

  expect(broker.createGrant('atc-s1', 'glm')).rejects.toMatchObject({
    code: 'not_found',
    data: { kind: 'secret', name: 'glm' },
  });
});

test('it refuses to read the grants of a host it does not hold as not found', () => {
  const broker = buildStubBinderBroker();

  expect(broker.readGrants('atc-s1')).rejects.toMatchObject({ code: 'not_found' });
});

test('it resolves the removal of a grant the host no longer holds as false', async () => {
  const broker = buildStubBinderBroker();

  broker.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm'],
  });

  broker.createSecret('glm', 'custom', []);

  await broker.createHost('s1');
  await broker.createGrant('atc-s1', 'glm');

  const first = await broker.removeGrant('atc-s1', 'glm');
  const second = await broker.removeGrant('atc-s1', 'glm');

  expect(first).toBeTrue();
  expect(second).toBeFalse();
});

test('it fails every grant removal with the set code and keeps the grant', async () => {
  const broker = buildStubBinderBroker();

  broker.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm'],
  });

  broker.createSecret('glm', 'custom', []);

  await broker.createHost('s1');
  await broker.createGrant('atc-s1', 'glm');

  broker.setGrantRemovalFailure('INTERNAL');

  const removed = broker.removeGrant('atc-s1', 'glm');

  expect(removed).rejects.toMatchObject({ code: 'refused', brokerCode: 'INTERNAL' });

  const grants = await broker.readGrants('atc-s1');

  expect(grants).toStrictEqual(['glm']);
});

test('it maps an unreachable removal failure to an unreachable broker', () => {
  const broker = buildStubBinderBroker();

  broker.setGrantRemovalFailure('UNREACHABLE');

  expect(broker.removeGrant('atc-s1', 'glm')).rejects.toMatchObject({
    code: 'unreachable',
    brokerCode: 'UNREACHABLE',
  });
});

test('it removes grants again once the removal failure is cleared', async () => {
  const broker = buildStubBinderBroker();

  broker.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm'],
  });

  broker.createSecret('glm', 'custom', []);

  await broker.createHost('s1');
  await broker.createGrant('atc-s1', 'glm');

  broker.setGrantRemovalFailure('INTERNAL');
  broker.setGrantRemovalFailure(null);

  const removed = await broker.removeGrant('atc-s1', 'glm');

  expect(removed).toBeTrue();
});
