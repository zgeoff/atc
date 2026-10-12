import { expect, test } from 'bun:test';
import { startStubImpdInfo } from '@atc/test-utils/start-stub-impd-info';
import { createStubImpPort } from '../test-utils/create-stub-imp-port';
import { buildImpCredentialBroker } from './build-imp-credential-broker';
import { ImpClientPort } from './imp-client-port';
import { verifyBrokerAuthority } from './verify-broker-authority';

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

test('it rejects a feature read impd never answered as unreachable', () => {
  const ctx = setupTest();

  ctx.port.setFeatureFailures(1);

  expect(ctx.broker.readFeatures()).rejects.toMatchObject({
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

test.each([
  ['absent', { sessionOffsets: true, leases: true }],
  ['false', { sessionOffsets: true, leases: true, grantableTokens: false, secretRebind: false }],
  ['strings', { sessionOffsets: true, leases: true, grantableTokens: 'true', secretRebind: 'yes' }],
])(
  'it refuses an impd whose grant flags are %s after one system info call',
  async (_kind, sent) => {
    // An impd stand-in on a real HTTP port that answers every call with
    // system info, for the real client to read.
    const impd = startStubImpdInfo();

    impd.info.features = sent;

    const port = new ImpClientPort({ url: impd.url, readToken: () => 'token' });

    const broker = buildImpCredentialBroker(port, {
      impPrefix: 'atc-',
      getImpName: (hostKey) => `atc-${hostKey}`,
      createImp: (hostKey) => port.createImp({ name: `atc-${hostKey}` }),
      destroyImp: (hostKey) => port.destroyImp(`atc-${hostKey}`),
    });

    const refusal = verifyBrokerAuthority(broker, { impNames: ['atc-s1'], secrets: ['glm'] });

    await Promise.allSettled([refusal]);

    expect(refusal).rejects.toMatchObject({ code: 'auth_impd_too_old' });
    expect(impd.paths).toStrictEqual(['/rpc/system/info']);
  },
);
