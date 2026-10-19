import { expect, test } from 'bun:test';
import { buildMockAuthBinding } from '../testing/build-mock-auth-binding';
import { buildStubCredentialBroker } from '../testing/build-stub-credential-broker';
import { loadOAuthStates } from './load-oauth-states';

test('it reads nothing from impd for a binding without an oauth secret', async () => {
  const broker = buildStubCredentialBroker();

  const states = await loadOAuthStates(
    broker,
    buildMockAuthBinding({
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
    }),
  );

  expect(states).toBeUndefined();
  expect(broker.calls).toStrictEqual([]);
});

test("it reads each bound oauth secret's sign-in state from one secret list once impd's version passes", async () => {
  const broker = buildStubCredentialBroker();

  broker.createSecret(
    'codex-chatgpt',
    'oauth',
    [{ host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' }],
    { status: 'ready', idClaims: { email: 'someone@example.com' } },
  );

  broker.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  const states = await loadOAuthStates(
    broker,
    buildMockAuthBinding({
      secrets: [
        {
          secret: 'codex-chatgpt',
          kind: 'oauth',
          rules: [{ host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' }],
        },
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
    }),
  );

  expect(states).toStrictEqual({
    'codex-chatgpt': { status: 'ready', idClaims: { email: 'someone@example.com' } },
  });

  expect(broker.calls).toStrictEqual(['verifyVersion', 'readSecrets']);
});

test('it refuses an outdated impd as an unavailable host before it lists any secret', async () => {
  const broker = buildStubCredentialBroker();

  broker.setOutdated(true);

  const loaded = loadOAuthStates(
    broker,
    buildMockAuthBinding({
      secrets: [
        {
          secret: 'codex-chatgpt',
          kind: 'oauth',
          rules: [{ host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' }],
        },
      ],
    }),
  );

  expect(loaded).rejects.toMatchObject({
    code: 'host_unavailable',
    data: { provider: 'imp', problem: 'impd_outdated' },
  });

  await loaded.catch(() => {});

  expect(broker.calls).toStrictEqual(['verifyVersion']);
});

test('it refuses a bound oauth secret that impd does not hold', () => {
  const broker = buildStubCredentialBroker();

  const loaded = loadOAuthStates(
    broker,
    buildMockAuthBinding({
      secrets: [
        {
          secret: 'codex-chatgpt',
          kind: 'oauth',
          rules: [{ host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' }],
        },
      ],
    }),
  );

  expect(loaded).rejects.toMatchObject({ code: 'auth_secret_mismatch' });
});

test('it refuses a bound oauth secret that impd holds as another kind', () => {
  const broker = buildStubCredentialBroker();

  broker.createSecret('codex-chatgpt', 'custom', [
    { host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' },
  ]);

  const loaded = loadOAuthStates(
    broker,
    buildMockAuthBinding({
      secrets: [
        {
          secret: 'codex-chatgpt',
          kind: 'oauth',
          rules: [{ host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' }],
        },
      ],
    }),
  );

  expect(loaded).rejects.toMatchObject({ code: 'auth_secret_mismatch' });
});

test('it turns a call impd fails into an unavailable host', () => {
  const broker = buildStubCredentialBroker();

  broker.setVersionFailures(1);

  const loaded = loadOAuthStates(
    broker,
    buildMockAuthBinding({
      secrets: [
        {
          secret: 'codex-chatgpt',
          kind: 'oauth',
          rules: [{ host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' }],
        },
      ],
    }),
  );

  expect(loaded).rejects.toMatchObject({
    code: 'host_unavailable',
    data: { provider: 'imp', problem: 'unreachable' },
  });
});
