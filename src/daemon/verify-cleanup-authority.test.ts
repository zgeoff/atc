import { expect, test } from 'bun:test';
import { FixtureImpPort } from '../../test/fixture-imp-port';
import { verifyCleanupAuthority } from './verify-cleanup-authority';

function setupTest() {
  const port = new FixtureImpPort();

  return {
    port,
    [Symbol.dispose]() {
      port[Symbol.dispose]();
    },
  };
}

test('it allows cleanup of the recorded imp after its secret was rebound', async () => {
  using cleanup = setupTest();

  cleanup.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  cleanup.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  const created = await cleanup.port.createImp({ name: 'atc-s1' });

  await cleanup.port.createGrant('atc-s1', 'glm');

  cleanup.port.updateSecret('glm', [{ host: 'api.z.ai', header: 'x-api-key', scheme: 'raw' }]);

  cleanup.port.calls.length = 0;

  const imp = await verifyCleanupAuthority(cleanup.port, { name: 'atc-s1', id: created.id });

  expect(imp).toMatchObject({ id: created.id, name: 'atc-s1' });
  expect(cleanup.port.calls).toStrictEqual(['tokens.whoami', 'imps.get atc-s1']);
});

test('it allows cleanup of the recorded imp after its secret was deleted', async () => {
  using cleanup = setupTest();

  cleanup.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  cleanup.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  const created = await cleanup.port.createImp({ name: 'atc-s1' });

  await cleanup.port.createGrant('atc-s1', 'glm');

  cleanup.port.removeSecret('glm');

  cleanup.port.calls.length = 0;

  const imp = await verifyCleanupAuthority(cleanup.port, { name: 'atc-s1', id: created.id });

  expect(imp).toMatchObject({ id: created.id, name: 'atc-s1' });
  expect(cleanup.port.calls).toStrictEqual(['tokens.whoami', 'imps.get atc-s1']);
});

test('it allows cleanup by a token that may no longer grant the bound secret', async () => {
  using cleanup = setupTest();

  const created = await cleanup.port.createImp({ name: 'atc-s1' });

  cleanup.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: [],
  });

  const imp = await verifyCleanupAuthority(cleanup.port, { name: 'atc-s1', id: created.id });

  expect(imp).toMatchObject({ id: created.id, name: 'atc-s1' });
});

test('it reports a recorded imp that impd no longer holds as nothing to clean up', async () => {
  using cleanup = setupTest();

  const created = await cleanup.port.createImp({ name: 'atc-s1' });

  await cleanup.port.destroyImp('atc-s1');

  const imp = await verifyCleanupAuthority(cleanup.port, { name: 'atc-s1', id: created.id });

  expect(imp).toBeNull();
});

test('it refuses cleanup of an imp made again under the recorded name', async () => {
  using cleanup = setupTest();

  const created = await cleanup.port.createImp({ name: 'atc-s1' });

  await cleanup.port.destroyImp('atc-s1');

  const remade = await cleanup.port.createImp({ name: 'atc-s1' });

  const refusal: unknown = await verifyCleanupAuthority(cleanup.port, {
    name: 'atc-s1',
    id: created.id,
  }).catch((error: unknown) => error);

  expect(refusal).toMatchObject({
    code: 'auth_runtime_mismatch',
    data: { imp: 'atc-s1', recordedID: created.id, actualID: remade.id },
  });
});

test('it refuses cleanup by a token whose patterns do not cover the recorded imp without looking it up', async () => {
  using cleanup = setupTest();

  const created = await cleanup.port.createImp({ name: 'atc-s1' });

  cleanup.port.setIdentity({
    kind: 'token',
    name: 'cloud-runtime',
    scope: 'manage',
    imps: ['harness-*'],
    grantable: [],
  });

  cleanup.port.calls.length = 0;

  const refusal: unknown = await verifyCleanupAuthority(cleanup.port, {
    name: 'atc-s1',
    id: created.id,
  }).catch((error: unknown) => error);

  expect(refusal).toMatchObject({ code: 'auth_imp_out_of_scope', data: { outside: ['atc-s1'] } });
  expect(cleanup.port.calls).toStrictEqual(['tokens.whoami']);
});

test('it refuses cleanup by a token that reaches every imp on the host', async () => {
  using cleanup = setupTest();

  const created = await cleanup.port.createImp({ name: 'atc-s1' });

  cleanup.port.setIdentity({
    kind: 'token',
    name: 'admin',
    scope: 'manage',
    imps: null,
    grantable: [],
  });

  const refusal: unknown = await verifyCleanupAuthority(cleanup.port, {
    name: 'atc-s1',
    id: created.id,
  }).catch((error: unknown) => error);

  expect(refusal).toMatchObject({ code: 'auth_token_too_broad' });
});
