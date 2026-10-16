import { expect, test } from 'bun:test';
import { buildMockAuthBinding } from '../test-utils/build-mock-auth-binding';
import { loadOAuthStates } from './load-oauth-states';
import { buildStubCredentialBroker } from './testing/build-stub-credential-broker';

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

test("it reads each bound oauth secret's sign-in state from impd's features and one secret list", async () => {
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

  expect(broker.calls).toStrictEqual(['readFeatures', 'readSecrets']);
});

test('it refuses an impd without oauth secrets before it lists any secret', async () => {
  const broker = buildStubCredentialBroker();

  broker.setFeatures({ oauthSecrets: false });

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
    code: 'auth_impd_too_old',
    message: 'impd lacks oauth secret support, which codex-chatgpt needs',
  });

  await loaded.catch(() => {});

  expect(broker.calls).toStrictEqual(['readFeatures']);
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

  broker.setFeatureFailures(1);

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
