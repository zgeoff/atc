import { expect, test } from 'bun:test';
import { FixtureImpPort } from '../../test/fixture-imp-port';
import { ImpClientPort } from './imp-client-port';
import { verifyBrokerAuthority } from './verify-broker-authority';

// The fixture imp port, plus an impd stand-in on a real HTTP port that
// records the path of each RPC call and answers system info with the
// features a test sets.
function setupTest() {
  const port = new FixtureImpPort();

  const paths: string[] = [];
  const info: { features: unknown } = { features: undefined };

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (request) => {
      paths.push(new URL(request.url).pathname);

      return Response.json({ json: info });
    },
  });

  return {
    port,
    impd: { url: `http://127.0.0.1:${String(server.port)}`, paths, info },
    async [Symbol.asyncDispose]() {
      await server.stop(true);

      port[Symbol.dispose]();
    },
  };
}

test('it lets a scoped token that may grant every bound secret activate the broker', async () => {
  await using gate = setupTest();

  gate.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  await verifyBrokerAuthority(gate.port, { impNames: ['atc-s1'], secrets: ['glm'] });

  expect(gate.port.calls).toStrictEqual(['system.info', 'tokens.whoami']);
});

test('it refuses an impd without grantable tokens and secret rebinds after reading only its features', async () => {
  await using gate = setupTest();

  gate.port.setOldDaemonFeatures();

  gate.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  const refusal: unknown = await verifyBrokerAuthority(gate.port, {
    impNames: ['atc-s1'],
    secrets: ['glm'],
  }).catch((error: unknown) => error);

  expect(refusal).toMatchObject({
    code: 'auth_impd_too_old',
    data: { grantableTokens: false, secretRebind: false },
  });

  expect(gate.port.calls).toStrictEqual(['system.info']);
});

test.each([
  ['grantable tokens', { grantableTokens: true, secretRebind: false }],
  ['secret rebinds', { grantableTokens: false, secretRebind: true }],
])('it refuses an impd that has only %s', async (_flag, flags) => {
  await using gate = setupTest();

  gate.port.features = { sessionOffsets: true, leases: true, ...flags };

  const refusal: unknown = await verifyBrokerAuthority(gate.port, {
    impNames: ['atc-s1'],
    secrets: ['glm'],
  }).catch((error: unknown) => error);

  expect(refusal).toMatchObject({ code: 'auth_impd_too_old' });
  expect(gate.port.calls).toStrictEqual(['system.info']);
});

test.each([
  ['absent', { sessionOffsets: true, leases: true }],
  ['false', { sessionOffsets: true, leases: true, grantableTokens: false, secretRebind: false }],
  ['strings', { sessionOffsets: true, leases: true, grantableTokens: 'true', secretRebind: 'yes' }],
])(
  'it refuses an impd whose grant flags are %s after one system info call',
  async (_kind, sent) => {
    await using gate = setupTest();

    gate.impd.info.features = sent;

    const port = new ImpClientPort({ url: gate.impd.url, readToken: () => 'token' });

    const refusal: unknown = await verifyBrokerAuthority(port, {
      impNames: ['atc-s1'],
      secrets: ['glm'],
    }).catch((error: unknown) => error);

    expect(refusal).toMatchObject({ code: 'auth_impd_too_old' });
    expect(gate.impd.paths).toStrictEqual(['/rpc/system/info']);
  },
);

test('it refuses a token below manage scope', async () => {
  await using gate = setupTest();

  gate.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'exec',
    imps: ['atc-*'],
    grantable: [],
  });

  const refusal: unknown = await verifyBrokerAuthority(gate.port, {
    impNames: ['atc-s1'],
    secrets: ['glm'],
  }).catch((error: unknown) => error);

  expect(refusal).toMatchObject({ code: 'auth_token_scope', data: { scope: 'exec' } });
  expect(gate.port.calls).toStrictEqual(['system.info', 'tokens.whoami']);
});

test('it refuses a token that reaches every imp on the host', async () => {
  await using gate = setupTest();

  gate.port.setIdentity({
    kind: 'token',
    name: 'admin',
    scope: 'manage',
    imps: null,
    grantable: [],
  });

  const refusal: unknown = await verifyBrokerAuthority(gate.port, {
    impNames: ['atc-s1'],
    secrets: ['glm'],
  }).catch((error: unknown) => error);

  expect(refusal).toMatchObject({ code: 'auth_token_too_broad', data: { imps: null } });
  expect(gate.port.calls).toStrictEqual(['system.info', 'tokens.whoami']);
});

test.each([[['*']], [['**']], [['atc-*', '*']]])(
  'it refuses a token whose patterns %p match every imp',
  async (imps) => {
    await using gate = setupTest();

    gate.port.setIdentity({
      kind: 'token',
      name: 'wide',
      scope: 'manage',
      imps,
      grantable: ['glm'],
    });

    const refusal: unknown = await verifyBrokerAuthority(gate.port, {
      impNames: ['atc-s1'],
      secrets: ['glm'],
    }).catch((error: unknown) => error);

    expect(refusal).toMatchObject({ code: 'auth_token_too_broad', data: { imps } });
    expect(gate.port.calls).toStrictEqual(['system.info', 'tokens.whoami']);
  },
);

test('it refuses a token whose patterns do not cover the imp the call touches', async () => {
  await using gate = setupTest();

  gate.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['harness-*'],
    grantable: ['glm'],
  });

  const refusal: unknown = await verifyBrokerAuthority(gate.port, {
    impNames: ['atc-s1'],
    secrets: ['glm'],
  }).catch((error: unknown) => error);

  expect(refusal).toMatchObject({
    code: 'auth_imp_out_of_scope',
    data: { outside: ['atc-s1'] },
  });

  expect(gate.port.calls).toStrictEqual(['system.info', 'tokens.whoami']);
});

test('it checks the imp names of the target namespace rather than a fixed prefix', async () => {
  await using gate = setupTest();

  gate.port.setIdentity({
    kind: 'token',
    name: 'cloud-runtime',
    scope: 'manage',
    imps: ['harness-*'],
    grantable: ['glm'],
  });

  await verifyBrokerAuthority(gate.port, { impNames: ['harness-s1'], secrets: ['glm'] });

  expect(gate.port.calls).toStrictEqual(['system.info', 'tokens.whoami']);
});

test('it refuses when any one of the imps the call touches is outside the patterns', async () => {
  await using gate = setupTest();

  gate.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  const refusal: unknown = await verifyBrokerAuthority(gate.port, {
    impNames: ['atc-s1', 'prod-db'],
    secrets: ['glm'],
  }).catch((error: unknown) => error);

  expect(refusal).toMatchObject({
    code: 'auth_imp_out_of_scope',
    data: { outside: ['prod-db'] },
  });
});

test('it refuses a token that may not grant every bound secret', async () => {
  await using gate = setupTest();

  gate.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  const refusal: unknown = await verifyBrokerAuthority(gate.port, {
    impNames: ['atc-s1'],
    secrets: ['glm', 'judge'],
  }).catch((error: unknown) => error);

  expect(refusal).toMatchObject({
    code: 'auth_secret_not_grantable',
    data: { missing: ['judge'] },
  });

  expect(gate.port.calls).toStrictEqual(['system.info', 'tokens.whoami']);
});
