import { expect, test } from 'bun:test';
import { registerTestCleanup } from '@atc/core/test-utils/register-test-cleanup';
import type { ImpSecretRule } from '../port/imp-port';
import { buildMockImpIdentity } from './build-mock-imp-identity';
import { createStubImpFleet } from './create-stub-imp-fleet';
import { createStubImpSecrets } from './create-stub-imp-secrets';

async function setupTest() {
  const rule: ImpSecretRule = {
    host: 'api.example.test',
    header: 'authorization',
    scheme: 'bearer',
  };

  const calls: string[] = [];

  const fleet = createStubImpFleet({
    principal: 'atc-daemon',
    now: () => 1,
    calls,
    createSpecs: [],
  });

  registerTestCleanup(async () => {
    for (const name of fleet.collectImpNames()) {
      await fleet.destroyImp(name);
    }
  });

  const secrets = createStubImpSecrets({ calls, fleet });

  await fleet.createImp({ name: 'atc-one' });

  secrets.createSecret('token-a', 'static', [rule]);
  secrets.setIdentity(buildMockImpIdentity({ name: 'atc', grantable: ['token-a'] }));

  return { secrets, fleet, calls, rule };
}

test('it reads the identity the port calls impd as', async () => {
  const ctx = await setupTest();
  const identity = await ctx.secrets.readIdentity();

  expect(identity).toStrictEqual(buildMockImpIdentity({ name: 'atc', grantable: ['token-a'] }));
});

test('it lists a secret with the imps that hold a grant of it', async () => {
  const ctx = await setupTest();

  await ctx.secrets.createGrant('atc-one', 'token-a');

  const secrets = await ctx.secrets.readSecrets();

  expect(secrets).toStrictEqual([
    { name: 'token-a', kind: 'static', rules: [ctx.rule], imps: ['atc-one'] },
  ]);
});

test('it lists the sign-in state of an oauth secret', async () => {
  const ctx = await setupTest();

  ctx.secrets.createSecret('login', 'oauth', [ctx.rule], { status: 'ready', idClaims: null });

  const secrets = await ctx.secrets.readSecrets();

  expect(secrets).toContainEqual(
    expect.objectContaining({
      name: 'login',
      kind: 'oauth',
      oauth: { status: 'ready', idClaims: null },
    }),
  );
});

test('it lists the grants of an imp', async () => {
  const ctx = await setupTest();

  await ctx.secrets.createGrant('atc-one', 'token-a');

  const grants = await ctx.secrets.readGrants('atc-one');

  expect(grants).toStrictEqual(['token-a']);
});

test('it refuses to list the grants of an imp it does not hold', async () => {
  const ctx = await setupTest();

  expect(ctx.secrets.readGrants('atc-two')).rejects.toMatchObject({ code: 'NOT_FOUND' });
});

test('it refuses a grant from an identity that cannot manage grants', async () => {
  const ctx = await setupTest();

  ctx.secrets.setIdentity(buildMockImpIdentity({ scope: 'read', grantable: ['token-a'] }));

  expect(ctx.secrets.createGrant('atc-one', 'token-a')).rejects.toMatchObject({
    code: 'FORBIDDEN',
    data: { reason: 'scope' },
  });
});

test('it refuses a grant on an imp outside the identity patterns', async () => {
  const ctx = await setupTest();

  await ctx.fleet.createImp({ name: 'other-one' });

  expect(ctx.secrets.createGrant('other-one', 'token-a')).rejects.toMatchObject({
    code: 'FORBIDDEN',
    data: { reason: 'imp_out_of_scope' },
  });
});

test('it refuses a grant of a secret the identity cannot grant', async () => {
  const ctx = await setupTest();

  ctx.secrets.createSecret('token-b', 'static', [{ ...ctx.rule, host: 'b.example.test' }]);

  expect(ctx.secrets.createGrant('atc-one', 'token-b')).rejects.toMatchObject({
    code: 'FORBIDDEN',
    data: { reason: 'not_grantable' },
  });
});

test('it refuses a grant on an imp it does not hold', async () => {
  const ctx = await setupTest();

  expect(ctx.secrets.createGrant('atc-two', 'token-a')).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
});

test('it refuses a grant of a secret it does not hold', async () => {
  const ctx = await setupTest();

  ctx.secrets.setIdentity(buildMockImpIdentity({ imps: null, grantable: ['missing'] }));

  expect(ctx.secrets.createGrant('atc-one', 'missing')).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'secret', name: 'missing' },
  });
});

test('it refuses a grant that covers a host another grant of the imp covers', async () => {
  const ctx = await setupTest();

  ctx.secrets.createSecret('token-b', 'static', [ctx.rule]);
  ctx.secrets.setIdentity(buildMockImpIdentity({ grantable: ['token-a', 'token-b'] }));

  await ctx.secrets.createGrant('atc-one', 'token-a');

  expect(ctx.secrets.createGrant('atc-one', 'token-b')).rejects.toMatchObject({
    code: 'CONFLICT',
    data: { kind: 'grant', name: 'atc-one/token-a' },
  });
});

test('it reports whether a revoke removed a grant', async () => {
  const ctx = await setupTest();

  await ctx.secrets.createGrant('atc-one', 'token-a');

  const first = await ctx.secrets.removeGrant('atc-one', 'token-a');
  const second = await ctx.secrets.removeGrant('atc-one', 'token-a');

  expect({ first, second }).toStrictEqual({ first: true, second: false });
});

test('it fails every revoke with the code it is given', async () => {
  const ctx = await setupTest();

  ctx.secrets.setGrantRemovalFailure('UNREACHABLE');

  expect(ctx.secrets.removeGrant('atc-one', 'token-a')).rejects.toMatchObject({
    code: 'UNREACHABLE',
  });
});

test('it drops the grants of a secret that is rebound and no longer covers it', async () => {
  const ctx = await setupTest();

  await ctx.secrets.createGrant('atc-one', 'token-a');

  ctx.secrets.updateSecret('token-a', [{ ...ctx.rule, host: 'new.example.test' }]);

  expect({
    grants: await ctx.secrets.readGrants('atc-one'),
    regrant: await ctx.secrets.createGrant('atc-one', 'token-a').catch((error: unknown) => error),
  }).toStrictEqual({
    grants: [],
    regrant: expect.objectContaining({ data: { reason: 'not_grantable' } }),
  });
});

test('it grants a rebound secret again once the identity is set again', async () => {
  const ctx = await setupTest();

  ctx.secrets.updateSecret('token-a', [{ ...ctx.rule, host: 'new.example.test' }]);
  ctx.secrets.setIdentity(buildMockImpIdentity({ grantable: ['token-a'] }));

  await ctx.secrets.createGrant('atc-one', 'token-a');

  const grants = await ctx.secrets.readGrants('atc-one');

  expect(grants).toStrictEqual(['token-a']);
});

test('it throws naming a secret it does not hold when it is rebound', async () => {
  const ctx = await setupTest();

  expect(() => {
    ctx.secrets.updateSecret('missing', []);
  }).toThrowWithMessage(Error, 'no secret missing');
});

test('it drops a removed secret and the grants of it', async () => {
  const ctx = await setupTest();

  await ctx.secrets.createGrant('atc-one', 'token-a');

  ctx.secrets.removeSecret('token-a');

  expect({
    secrets: await ctx.secrets.readSecrets(),
    grants: await ctx.secrets.readGrants('atc-one'),
  }).toStrictEqual({ secrets: [], grants: [] });
});

test('it records each call it answers', async () => {
  const ctx = await setupTest();

  await ctx.secrets.readIdentity();
  await ctx.secrets.createGrant('atc-one', 'token-a');
  await ctx.secrets.readGrants('atc-one');

  expect(ctx.calls).toStrictEqual([
    'imps.create atc-one',
    'tokens.whoami',
    'grants.add atc-one token-a',
    'grants.list atc-one',
  ]);
});
