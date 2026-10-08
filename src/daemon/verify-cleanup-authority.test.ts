import { expect, test } from 'bun:test';
import { createStubImpPort } from '../test-utils/create-stub-imp-port';
import { verifyCleanupAuthority } from './verify-cleanup-authority';

function setupTest() {
  const port = createStubImpPort();

  return { port };
}

test('it allows cleanup of the recorded imp after its secret was rebound', async () => {
  const ctx = setupTest();

  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  const created = await ctx.port.createImp({ name: 'atc-s1' });

  await ctx.port.createGrant('atc-s1', 'glm');

  ctx.port.updateSecret('glm', [{ host: 'api.z.ai', header: 'x-api-key', scheme: 'raw' }]);

  ctx.port.calls.length = 0;

  const imp = await verifyCleanupAuthority(ctx.port, { name: 'atc-s1', id: created.id }, 'atc-');

  expect(imp).toStrictEqual({
    id: created.id,
    name: 'atc-s1',
    state: 'running',
    leases: [],
    otherLeaseCount: 0,
  });

  expect(ctx.port.calls).toStrictEqual(['tokens.whoami', 'imps.get atc-s1']);
});

test('it allows cleanup of the recorded imp after its secret was deleted', async () => {
  const ctx = setupTest();

  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  const created = await ctx.port.createImp({ name: 'atc-s1' });

  await ctx.port.createGrant('atc-s1', 'glm');

  ctx.port.removeSecret('glm');

  ctx.port.calls.length = 0;

  const imp = await verifyCleanupAuthority(ctx.port, { name: 'atc-s1', id: created.id }, 'atc-');

  expect(imp).toStrictEqual({
    id: created.id,
    name: 'atc-s1',
    state: 'running',
    leases: [],
    otherLeaseCount: 0,
  });

  expect(ctx.port.calls).toStrictEqual(['tokens.whoami', 'imps.get atc-s1']);
});

test('it allows cleanup by a token that may no longer grant the bound secret', async () => {
  const ctx = setupTest();

  const created = await ctx.port.createImp({ name: 'atc-s1' });

  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: [],
  });

  const imp = await verifyCleanupAuthority(ctx.port, { name: 'atc-s1', id: created.id }, 'atc-');

  expect(imp).toStrictEqual({
    id: created.id,
    name: 'atc-s1',
    state: 'running',
    leases: [],
    otherLeaseCount: 0,
  });
});

test('it reports a recorded imp that impd no longer holds as nothing to clean up', async () => {
  const ctx = setupTest();

  const created = await ctx.port.createImp({ name: 'atc-s1' });

  await ctx.port.destroyImp('atc-s1');

  const imp = await verifyCleanupAuthority(ctx.port, { name: 'atc-s1', id: created.id }, 'atc-');

  expect(imp).toBeNull();
});

test('it refuses cleanup of an imp made again under the recorded name', async () => {
  const ctx = setupTest();

  const created = await ctx.port.createImp({ name: 'atc-s1' });

  await ctx.port.destroyImp('atc-s1');

  const remade = await ctx.port.createImp({ name: 'atc-s1' });

  const verified = verifyCleanupAuthority(
    ctx.port,
    {
      name: 'atc-s1',
      id: created.id,
    },
    'atc-',
  );

  expect(verified).rejects.toMatchObject({
    code: 'auth_runtime_mismatch',
    data: { imp: 'atc-s1', recordedID: created.id, actualID: remade.id },
  });
});

test('it refuses cleanup by a token whose patterns do not cover the recorded imp without looking it up', async () => {
  const ctx = setupTest();

  const created = await ctx.port.createImp({ name: 'atc-s1' });

  ctx.port.setIdentity({
    kind: 'token',
    name: 'cloud-runtime',
    scope: 'manage',
    imps: ['atc-other-*'],
    grantable: [],
  });

  ctx.port.calls.length = 0;

  const verified = verifyCleanupAuthority(
    ctx.port,
    {
      name: 'atc-s1',
      id: created.id,
    },
    'atc-',
  );

  expect(verified).rejects.toMatchObject({
    code: 'auth_imp_out_of_scope',
    data: { outside: ['atc-s1'] },
  });

  expect(ctx.port.calls).toStrictEqual(['tokens.whoami']);
});

test('it refuses cleanup by a token that reaches every imp on the host', async () => {
  const ctx = setupTest();

  const created = await ctx.port.createImp({ name: 'atc-s1' });

  ctx.port.setIdentity({
    kind: 'token',
    name: 'admin',
    scope: 'manage',
    imps: null,
    grantable: [],
  });

  const verified = verifyCleanupAuthority(
    ctx.port,
    {
      name: 'atc-s1',
      id: created.id,
    },
    'atc-',
  );

  expect(verified).rejects.toMatchObject({ code: 'auth_token_too_broad' });
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
  'it refuses cleanup by a token whose patterns %p reach imps outside the namespace',
  async (imps) => {
    const ctx = setupTest();

    const created = await ctx.port.createImp({ name: 'atc-s1' });

    ctx.port.setIdentity({
      kind: 'token',
      name: 'wide',
      scope: 'manage',
      imps,
      grantable: [],
    });

    ctx.port.calls.length = 0;

    const verified = verifyCleanupAuthority(
      ctx.port,
      {
        name: 'atc-s1',
        id: created.id,
      },
      'atc-',
    );

    expect(verified).rejects.toMatchObject({
      code: 'auth_token_too_broad',
      data: { token: 'wide', imps },
    });

    expect(ctx.port.calls).toStrictEqual(['tokens.whoami']);
  },
);

test('it allows cleanup by a token whose literal imp name is the recorded imp', async () => {
  const ctx = setupTest();

  const created = await ctx.port.createImp({ name: 'atc-s1' });

  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-s1'],
    grantable: [],
  });

  const imp = await verifyCleanupAuthority(ctx.port, { name: 'atc-s1', id: created.id }, 'atc-');

  expect(imp).toStrictEqual({
    id: created.id,
    name: 'atc-s1',
    state: 'running',
    leases: [],
    otherLeaseCount: 0,
  });
});
