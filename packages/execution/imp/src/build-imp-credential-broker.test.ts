import { expect, test } from 'bun:test';
import { startStubImpdInfo } from '@atc/test-utils';
import { buildImpCredentialBroker } from './build-imp-credential-broker';
import { createImpClientPort } from './create-imp-client-port';
import { createStubImpPort } from './testing/create-stub-imp-port';

// A broker over a stub imp port that names each host `atc-<key>`, creates
// it as a plain imp, and destroys it through the port.
function setupTest() {
  const port = createStubImpPort();

  const broker = buildImpCredentialBroker(port, {
    impPrefix: 'atc-',
    getImpName: (hostKey) => `atc-${hostKey}`,
    createImp: (hostKey) => port.createImp({ name: `atc-${hostKey}` }),
    destroyImp: (hostKey) => port.destroyImp(`atc-${hostKey}`),
  });

  return { port, broker };
}

test('it reads the token as an identity whose host patterns are its imp patterns', async () => {
  const ctx = setupTest();

  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  const identity = await ctx.broker.readIdentity();

  expect(identity).toStrictEqual({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm'],
  });
});

test('it names the broker imp, with the impz step that renews a secret and the impd version to upgrade to', () => {
  const ctx = setupTest();

  expect(ctx.broker.describe.name).toBe('imp');

  expect(ctx.broker.describe.renewSecret?.('codex-chatgpt', 'oauth')).toBe(
    'run impz secret add codex-chatgpt --kind oauth ... --replace',
  );

  expect(ctx.broker.describe.upgrade).toBe('upgrade impd to 2.2.0 or later');
});

test('it reads an imp as a host with its id and name', async () => {
  const ctx = setupTest();

  const created = await ctx.broker.createHost('s1');
  const read = await ctx.broker.readHost('atc-s1');

  expect(read).toStrictEqual({ id: created.id, name: 'atc-s1' });
});

test('it reads each secret with its kind and rules', async () => {
  const ctx = setupTest();

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  const secrets = await ctx.broker.readSecrets();

  expect(secrets).toStrictEqual([
    {
      name: 'glm',
      kind: 'custom',
      rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
    },
  ]);
});

test('it rejects a grant read on a missing imp as not found, keeping impd code', () => {
  const ctx = setupTest();

  expect(ctx.broker.readGrants('atc-s1')).rejects.toMatchObject({
    name: 'CredentialBrokerError',
    code: 'not_found',
    brokerCode: 'NOT_FOUND',
  });
});

test('it rejects a create under a name impd holds as refused, keeping impd code', async () => {
  const ctx = setupTest();

  await ctx.broker.createHost('s1');

  expect(ctx.broker.createHost('s1')).rejects.toMatchObject({
    code: 'refused',
    brokerCode: 'CONFLICT',
  });
});

test('it rejects a version check impd never answered as unreachable', () => {
  const ctx = setupTest();

  ctx.port.setVersionFailures(1);

  expect(ctx.broker.verifyVersion()).rejects.toMatchObject({
    code: 'unreachable',
    brokerCode: 'UNREACHABLE',
  });
});

test('it rejects a grant removal impd forbids as forbidden', async () => {
  const ctx = setupTest();

  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', []);

  await ctx.broker.createHost('s1');
  await ctx.broker.createGrant('atc-s1', 'glm');

  ctx.port.setGrantRemovalFailure('FORBIDDEN');

  expect(ctx.broker.removeGrant('atc-s1', 'glm')).rejects.toMatchObject({ code: 'forbidden' });
});

test('it rejects the version check of an outdated impd as too old after one system info call', () => {
  // An impd stand-in on a real HTTP port that answers every call with
  // system info, for the real client to read.
  const impd = startStubImpdInfo();

  impd.info.version = '2.1.0';

  const port = createImpClientPort({ url: impd.url, readToken: () => 'token' });

  const broker = buildImpCredentialBroker(port, {
    impPrefix: 'atc-',
    getImpName: (hostKey) => `atc-${hostKey}`,
    createImp: (hostKey) => port.createImp({ name: `atc-${hostKey}` }),
    destroyImp: (hostKey) => port.destroyImp(`atc-${hostKey}`),
  });

  expect(broker.verifyVersion()).rejects.toMatchObject({
    code: 'too_old',
    brokerCode: 'IMPD_OUTDATED',
  });

  expect(impd.paths).toStrictEqual(['/rpc/system/info']);
});
