import { expect, test } from 'bun:test';
import { buildStubCredentialBroker } from '../testing/build-stub-credential-broker';
import { BrokerAuthorityError } from './broker-authority-error';
import { verifyBrokerAuthority } from './verify-broker-authority';

test('it lets a scoped identity that may grant every bound secret activate the broker', async () => {
  const broker = buildStubCredentialBroker('atc-');

  broker.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  await verifyBrokerAuthority(broker, { impNames: ['atc-s1'], secrets: ['glm'] });

  expect(broker.calls).toStrictEqual(['verifyVersion', 'readIdentity']);
});

test('it refuses an outdated broker with its version refusal before it checks the token', () => {
  const broker = buildStubCredentialBroker('atc-');

  broker.setOutdated(true);

  broker.setIdentity({
    name: 'atc-runtime',
    scope: 'exec',
    hosts: ['atc-*'],
    grantable: ['glm'],
  });

  const refusal = verifyBrokerAuthority(broker, { impNames: ['atc-s1'], secrets: ['glm'] });

  expect(refusal).rejects.toMatchObject({ code: 'refused', brokerCode: 'IMPD_OUTDATED' });
  expect(broker.calls).toStrictEqual(['verifyVersion', 'readIdentity']);
});

test('it refuses an identity below manage scope', () => {
  const broker = buildStubCredentialBroker('atc-');

  broker.setIdentity({
    name: 'atc-runtime',
    scope: 'exec',
    hosts: ['atc-*'],
    grantable: [],
  });

  const refusal = verifyBrokerAuthority(broker, { impNames: ['atc-s1'], secrets: ['glm'] });

  expect(refusal).rejects.toMatchObject({ code: 'auth_token_scope', data: { scope: 'exec' } });
  expect(broker.calls).toStrictEqual(['verifyVersion', 'readIdentity']);
});

test('it refuses an identity that reaches every host', () => {
  const broker = buildStubCredentialBroker('atc-');

  broker.setIdentity({
    name: 'admin',
    scope: 'manage',
    hosts: null,
    grantable: [],
  });

  const refusal = verifyBrokerAuthority(broker, { impNames: ['atc-s1'], secrets: ['glm'] });

  expect(refusal).rejects.toMatchObject({ code: 'auth_token_too_broad', data: { imps: null } });
  expect(broker.calls).toStrictEqual(['verifyVersion', 'readIdentity']);
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
])(
  'it refuses an identity whose patterns %p reach hosts outside the namespace',
  (hosts, offending) => {
    const broker = buildStubCredentialBroker('atc-');

    broker.setIdentity({
      name: 'wide',
      scope: 'manage',
      hosts,
      grantable: ['glm'],
    });

    const refusal = verifyBrokerAuthority(broker, { impNames: ['atc-s1'], secrets: ['glm'] });

    expect(refusal).rejects.toMatchObject({
      code: 'auth_token_too_broad',
      data: { token: 'wide', imps: hosts, offending },
    });

    expect(broker.calls).toStrictEqual(['verifyVersion', 'readIdentity']);
  },
);

test('it lets an identity whose literal host names sit inside the namespace activate the broker', async () => {
  const broker = buildStubCredentialBroker('atc-');

  broker.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-s1', 'atc-s2'],
    grantable: ['glm'],
  });

  await verifyBrokerAuthority(broker, { impNames: ['atc-s1'], secrets: ['glm'] });

  expect(broker.calls).toStrictEqual(['verifyVersion', 'readIdentity']);
});

test('it rejects an empty namespace prefix as a broken invariant', () => {
  const broker = buildStubCredentialBroker('');

  broker.setIdentity({
    name: 'wide',
    scope: 'manage',
    hosts: ['*'],
    grantable: ['glm'],
  });

  const refusal = verifyBrokerAuthority(broker, { impNames: ['atc-s1'], secrets: ['glm'] });

  expect(refusal).rejects.toThrowWithMessage(
    Error,
    'the imp name prefix of a runtime namespace must not be empty',
  );

  expect(refusal).rejects.not.toBeInstanceOf(BrokerAuthorityError);
});

test('it refuses an identity whose patterns do not cover the host the call touches', () => {
  const broker = buildStubCredentialBroker('atc-');

  broker.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-other-*'],
    grantable: ['glm'],
  });

  const refusal = verifyBrokerAuthority(broker, { impNames: ['atc-s1'], secrets: ['glm'] });

  expect(refusal).rejects.toMatchObject({
    code: 'auth_imp_out_of_scope',
    data: { outside: ['atc-s1'] },
  });

  expect(broker.calls).toStrictEqual(['verifyVersion', 'readIdentity']);
});

test('it checks the host names of the target namespace rather than a fixed prefix', async () => {
  const broker = buildStubCredentialBroker('harness-');

  broker.setIdentity({
    name: 'cloud-runtime',
    scope: 'manage',
    hosts: ['harness-*'],
    grantable: ['glm'],
  });

  await verifyBrokerAuthority(broker, { impNames: ['harness-s1'], secrets: ['glm'] });

  expect(broker.calls).toStrictEqual(['verifyVersion', 'readIdentity']);
});

test('it refuses when any one of the hosts the call touches is outside the patterns', () => {
  const broker = buildStubCredentialBroker('atc-');

  broker.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm'],
  });

  const refusal = verifyBrokerAuthority(broker, {
    impNames: ['atc-s1', 'prod-db'],
    secrets: ['glm'],
  });

  expect(refusal).rejects.toMatchObject({
    code: 'auth_imp_out_of_scope',
    data: { outside: ['prod-db'] },
  });
});

test('it refuses an identity that may not grant every bound secret', () => {
  const broker = buildStubCredentialBroker('atc-');

  broker.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm'],
  });

  const refusal = verifyBrokerAuthority(broker, {
    impNames: ['atc-s1'],
    secrets: ['glm', 'judge'],
  });

  expect(refusal).rejects.toMatchObject({
    code: 'auth_secret_not_grantable',
    data: { missing: ['judge'] },
  });

  expect(broker.calls).toStrictEqual(['verifyVersion', 'readIdentity']);
});
