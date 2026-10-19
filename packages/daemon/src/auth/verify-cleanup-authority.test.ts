import { expect, test } from 'bun:test';
import { buildStubCredentialBroker } from '../testing/build-stub-credential-broker';
import { verifyCleanupAuthority } from './verify-cleanup-authority';

function setupTest() {
  const broker = buildStubCredentialBroker('atc-');

  return { broker };
}

test('it allows cleanup of the recorded host after its secret was rebound', async () => {
  const ctx = setupTest();

  ctx.broker.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.broker.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  const created = await ctx.broker.createHost('s1');

  await ctx.broker.createGrant('atc-s1', 'glm');

  ctx.broker.updateSecret('glm', [{ host: 'api.z.ai', header: 'x-api-key', scheme: 'raw' }]);

  ctx.broker.calls.length = 0;

  const host = await verifyCleanupAuthority(ctx.broker, { name: 'atc-s1', id: created.id });

  expect(host).toStrictEqual({ id: created.id, name: 'atc-s1' });
  expect(ctx.broker.calls).toStrictEqual(['readIdentity', 'readHost atc-s1']);
});

test('it allows cleanup of the recorded host after its secret was deleted', async () => {
  const ctx = setupTest();

  ctx.broker.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.broker.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  const created = await ctx.broker.createHost('s1');

  await ctx.broker.createGrant('atc-s1', 'glm');

  ctx.broker.removeSecret('glm');

  ctx.broker.calls.length = 0;

  const host = await verifyCleanupAuthority(ctx.broker, { name: 'atc-s1', id: created.id });

  expect(host).toStrictEqual({ id: created.id, name: 'atc-s1' });
  expect(ctx.broker.calls).toStrictEqual(['readIdentity', 'readHost atc-s1']);
});

test('it allows cleanup by an identity that may no longer grant the bound secret', async () => {
  const ctx = setupTest();

  const created = await ctx.broker.createHost('s1');

  ctx.broker.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: [],
  });

  const host = await verifyCleanupAuthority(ctx.broker, { name: 'atc-s1', id: created.id });

  expect(host).toStrictEqual({ id: created.id, name: 'atc-s1' });
});

test('it reports a recorded host that the broker no longer holds as nothing to clean up', async () => {
  const ctx = setupTest();

  const created = await ctx.broker.createHost('s1');

  await ctx.broker.destroyHost('s1');

  const host = await verifyCleanupAuthority(ctx.broker, { name: 'atc-s1', id: created.id });

  expect(host).toBeNull();
});

test('it refuses cleanup of a host made again under the recorded name', async () => {
  const ctx = setupTest();

  const created = await ctx.broker.createHost('s1');

  await ctx.broker.destroyHost('s1');

  const remade = await ctx.broker.createHost('s1');

  const verified = verifyCleanupAuthority(ctx.broker, { name: 'atc-s1', id: created.id });

  expect(verified).rejects.toMatchObject({
    code: 'auth_runtime_mismatch',
    data: { hostName: 'atc-s1', recordedID: created.id, actualID: remade.id },
  });
});

test('it refuses cleanup by an identity whose patterns do not cover the recorded host without looking it up', async () => {
  const ctx = setupTest();

  const created = await ctx.broker.createHost('s1');

  ctx.broker.setIdentity({
    name: 'cloud-runtime',
    scope: 'manage',
    hosts: ['atc-other-*'],
    grantable: [],
  });

  ctx.broker.calls.length = 0;

  const verified = verifyCleanupAuthority(ctx.broker, { name: 'atc-s1', id: created.id });

  expect(verified).rejects.toMatchObject({
    code: 'auth_host_out_of_scope',
    data: { outside: ['atc-s1'] },
  });

  expect(ctx.broker.calls).toStrictEqual(['readIdentity']);
});

test('it refuses cleanup by an identity that reaches every host', async () => {
  const ctx = setupTest();

  const created = await ctx.broker.createHost('s1');

  ctx.broker.setIdentity({
    name: 'admin',
    scope: 'manage',
    hosts: null,
    grantable: [],
  });

  const verified = verifyCleanupAuthority(ctx.broker, { name: 'atc-s1', id: created.id });

  expect(verified).rejects.toMatchObject({ code: 'auth_token_too_broad' });
});

test('it refuses cleanup by an identity that cannot manage hosts', async () => {
  const ctx = setupTest();

  const created = await ctx.broker.createHost('s1');

  ctx.broker.setIdentity({
    name: 'reader',
    scope: 'read',
    hosts: ['atc-*'],
    grantable: [],
  });

  const verified = verifyCleanupAuthority(ctx.broker, { name: 'atc-s1', id: created.id });

  expect(verified).rejects.toMatchObject({ code: 'auth_token_scope' });
});

test.each([
  [
    [
      'a*',
      'b*',
      'c*',
      'd*',
      'e*',
      'f*',
      'g*',
      'h*',
      'i*',
      'j*',
      'k*',
      'l*',
      'm*',
      'n*',
      'o*',
      'p*',
      'q*',
      'r*',
      's*',
      't*',
      'u*',
      'v*',
      'w*',
      'x*',
      'y*',
      'z*',
    ],
  ],
  [['atc-*', 'prod-*']],
  [['prod']],
  [['atc*']],
])(
  'it refuses cleanup by an identity whose patterns %p reach hosts outside the namespace',
  async (hosts) => {
    const ctx = setupTest();

    const created = await ctx.broker.createHost('s1');

    ctx.broker.setIdentity({
      name: 'wide',
      scope: 'manage',
      hosts,
      grantable: [],
    });

    ctx.broker.calls.length = 0;

    const verified = verifyCleanupAuthority(ctx.broker, { name: 'atc-s1', id: created.id });

    expect(verified).rejects.toMatchObject({
      code: 'auth_token_too_broad',
      data: { token: 'wide', hosts },
    });

    expect(ctx.broker.calls).toStrictEqual(['readIdentity']);
  },
);

test('it allows cleanup by an identity whose literal host name is the recorded host', async () => {
  const ctx = setupTest();

  const created = await ctx.broker.createHost('s1');

  ctx.broker.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-s1'],
    grantable: [],
  });

  const host = await verifyCleanupAuthority(ctx.broker, { name: 'atc-s1', id: created.id });

  expect(host).toStrictEqual({ id: created.id, name: 'atc-s1' });
});
