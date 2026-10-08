import { expect, test } from 'bun:test';
import { createStubImpPort } from '../test-utils/create-stub-imp-port';
import { startStubImpdInfo } from '../test-utils/start-stub-impd-info';
import { BrokerAuthorityError } from './broker-authority-error';
import { ImpClientPort } from './imp-client-port';
import { verifyBrokerAuthority } from './verify-broker-authority';

/**
 * The stub imp port.
 */
function setupTest() {
  const port = createStubImpPort();

  return { port };
}

test('it lets a scoped token that may grant every bound secret activate the broker', async () => {
  const ctx = setupTest();

  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  await verifyBrokerAuthority(ctx.port, { impNames: ['atc-s1'], secrets: ['glm'] }, 'atc-');

  expect(ctx.port.calls).toStrictEqual(['system.info', 'tokens.whoami']);
});

test('it refuses an impd without grantable tokens, secret rebinds and exec requirements after reading only its features', () => {
  const ctx = setupTest();

  ctx.port.features = {
    sessionOffsets: true,
    leases: true,
    grantableTokens: false,
    secretRebind: false,
    execRequire: false,
    oauthSecrets: false,
  };

  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  const refusal = verifyBrokerAuthority(
    ctx.port,
    {
      impNames: ['atc-s1'],
      secrets: ['glm'],
    },
    'atc-',
  );

  expect(refusal).rejects.toMatchObject({
    code: 'auth_impd_too_old',
    data: { grantableTokens: false, secretRebind: false, execRequire: false },
  });

  expect(ctx.port.calls).toStrictEqual(['system.info']);
});

test.each([
  ['grantable tokens', { grantableTokens: true, secretRebind: false, execRequire: false }],
  ['secret rebinds', { grantableTokens: false, secretRebind: true, execRequire: false }],
  ['exec requirements', { grantableTokens: false, secretRebind: false, execRequire: true }],
  [
    'grantable tokens and secret rebinds',
    { grantableTokens: true, secretRebind: true, execRequire: false },
  ],
])('it refuses an impd that has only %s', (_flag, flags) => {
  const ctx = setupTest();

  ctx.port.features = { sessionOffsets: true, leases: true, oauthSecrets: false, ...flags };

  const refusal = verifyBrokerAuthority(
    ctx.port,
    {
      impNames: ['atc-s1'],
      secrets: ['glm'],
    },
    'atc-',
  );

  expect(refusal).rejects.toMatchObject({ code: 'auth_impd_too_old' });
  expect(ctx.port.calls).toStrictEqual(['system.info']);
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

    const refusal = verifyBrokerAuthority(
      port,
      {
        impNames: ['atc-s1'],
        secrets: ['glm'],
      },
      'atc-',
    );

    await Promise.allSettled([refusal]);

    expect(refusal).rejects.toMatchObject({ code: 'auth_impd_too_old' });
    expect(impd.paths).toStrictEqual(['/rpc/system/info']);
  },
);

test('it refuses a token below manage scope', () => {
  const ctx = setupTest();

  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'exec',
    imps: ['atc-*'],
    grantable: [],
  });

  const refusal = verifyBrokerAuthority(
    ctx.port,
    {
      impNames: ['atc-s1'],
      secrets: ['glm'],
    },
    'atc-',
  );

  expect(refusal).rejects.toMatchObject({ code: 'auth_token_scope', data: { scope: 'exec' } });
  expect(ctx.port.calls).toStrictEqual(['system.info', 'tokens.whoami']);
});

test('it refuses a token that reaches every imp on the host', () => {
  const ctx = setupTest();

  ctx.port.setIdentity({
    kind: 'token',
    name: 'admin',
    scope: 'manage',
    imps: null,
    grantable: [],
  });

  const refusal = verifyBrokerAuthority(
    ctx.port,
    {
      impNames: ['atc-s1'],
      secrets: ['glm'],
    },
    'atc-',
  );

  expect(refusal).rejects.toMatchObject({ code: 'auth_token_too_broad', data: { imps: null } });
  expect(ctx.port.calls).toStrictEqual(['system.info', 'tokens.whoami']);
});

test.each([
  [['*'], ['*']],
  [['**'], ['**']],
  [['atc-*', '*'], ['*']],
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
  [['atc-*', 'prod-*'], ['prod-*']],
  [['atc-s1', 'prod'], ['prod']],
  [['atc*'], ['atc*']],
])('it refuses a token whose patterns %p reach imps outside the namespace', (imps, offending) => {
  const ctx = setupTest();

  ctx.port.setIdentity({
    kind: 'token',
    name: 'wide',
    scope: 'manage',
    imps,
    grantable: ['glm'],
  });

  const refusal = verifyBrokerAuthority(
    ctx.port,
    {
      impNames: ['atc-s1'],
      secrets: ['glm'],
    },
    'atc-',
  );

  expect(refusal).rejects.toMatchObject({
    code: 'auth_token_too_broad',
    data: { token: 'wide', imps, offending },
  });

  expect(ctx.port.calls).toStrictEqual(['system.info', 'tokens.whoami']);
});

test('it lets a token whose literal imp names sit inside the namespace activate the broker', async () => {
  const ctx = setupTest();

  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-s1', 'atc-s2'],
    grantable: ['glm'],
  });

  await verifyBrokerAuthority(ctx.port, { impNames: ['atc-s1'], secrets: ['glm'] }, 'atc-');

  expect(ctx.port.calls).toStrictEqual(['system.info', 'tokens.whoami']);
});

test('it rejects an empty namespace prefix as a broken invariant', () => {
  const ctx = setupTest();

  ctx.port.setIdentity({
    kind: 'token',
    name: 'wide',
    scope: 'manage',
    imps: ['*'],
    grantable: ['glm'],
  });

  const refusal = verifyBrokerAuthority(
    ctx.port,
    {
      impNames: ['atc-s1'],
      secrets: ['glm'],
    },
    '',
  );

  expect(refusal).rejects.toThrowWithMessage(
    Error,
    'the imp name prefix of a runtime namespace must not be empty',
  );

  expect(refusal).rejects.not.toBeInstanceOf(BrokerAuthorityError);
});

test('it refuses a token whose patterns do not cover the imp the call touches', () => {
  const ctx = setupTest();

  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-other-*'],
    grantable: ['glm'],
  });

  const refusal = verifyBrokerAuthority(
    ctx.port,
    {
      impNames: ['atc-s1'],
      secrets: ['glm'],
    },
    'atc-',
  );

  expect(refusal).rejects.toMatchObject({
    code: 'auth_imp_out_of_scope',
    data: { outside: ['atc-s1'] },
  });

  expect(ctx.port.calls).toStrictEqual(['system.info', 'tokens.whoami']);
});

test('it checks the imp names of the target namespace rather than a fixed prefix', async () => {
  const ctx = setupTest();

  ctx.port.setIdentity({
    kind: 'token',
    name: 'cloud-runtime',
    scope: 'manage',
    imps: ['harness-*'],
    grantable: ['glm'],
  });

  await verifyBrokerAuthority(ctx.port, { impNames: ['harness-s1'], secrets: ['glm'] }, 'harness-');

  expect(ctx.port.calls).toStrictEqual(['system.info', 'tokens.whoami']);
});

test('it refuses when any one of the imps the call touches is outside the patterns', () => {
  const ctx = setupTest();

  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  const refusal = verifyBrokerAuthority(
    ctx.port,
    {
      impNames: ['atc-s1', 'prod-db'],
      secrets: ['glm'],
    },
    'atc-',
  );

  expect(refusal).rejects.toMatchObject({
    code: 'auth_imp_out_of_scope',
    data: { outside: ['prod-db'] },
  });
});

test('it refuses a token that may not grant every bound secret', () => {
  const ctx = setupTest();

  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  const refusal = verifyBrokerAuthority(
    ctx.port,
    {
      impNames: ['atc-s1'],
      secrets: ['glm', 'judge'],
    },
    'atc-',
  );

  expect(refusal).rejects.toMatchObject({
    code: 'auth_secret_not_grantable',
    data: { missing: ['judge'] },
  });

  expect(ctx.port.calls).toStrictEqual(['system.info', 'tokens.whoami']);
});

test('it refuses an impd without oauth secrets for a binding that holds one', () => {
  const ctx = setupTest();

  ctx.port.features = { ...ctx.port.features, oauthSecrets: false };

  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['codex-chatgpt'],
  });

  const refusal = verifyBrokerAuthority(
    ctx.port,
    { impNames: ['atc-s1'], secrets: ['codex-chatgpt'], oauthSecrets: ['codex-chatgpt'] },
    'atc-',
  );

  expect(refusal).rejects.toBeInstanceOf(BrokerAuthorityError);

  expect(refusal).rejects.toMatchObject({
    code: 'auth_impd_too_old',
    message: 'impd lacks oauth secret support, which codex-chatgpt needs',
    data: { oauthSecrets: false, secrets: ['codex-chatgpt'] },
  });

  expect(ctx.port.calls).toStrictEqual(['system.info']);
});

test('it lets an impd without oauth secrets activate a binding that holds none', async () => {
  const ctx = setupTest();

  ctx.port.features = { ...ctx.port.features, oauthSecrets: false };

  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  await verifyBrokerAuthority(
    ctx.port,
    { impNames: ['atc-s1'], secrets: ['glm'], oauthSecrets: [] },
    'atc-',
  );

  expect(ctx.port.calls).toStrictEqual(['system.info', 'tokens.whoami']);
});

test('it lets an impd with oauth secrets activate a binding that holds one', async () => {
  const ctx = setupTest();

  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['codex-chatgpt'],
  });

  await verifyBrokerAuthority(
    ctx.port,
    { impNames: ['atc-s1'], secrets: ['codex-chatgpt'], oauthSecrets: ['codex-chatgpt'] },
    'atc-',
  );

  expect(ctx.port.calls).toStrictEqual(['system.info', 'tokens.whoami']);
});
