import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { buildMockAuthBinding } from '../test-utils/build-mock-auth-binding';
import { createStubImpPort } from '../test-utils/create-stub-imp-port';
import { registerTestCleanup } from '../test-utils/register-test-cleanup';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { ImpProvider } from './imp-provider';
import { loadOAuthStates } from './load-oauth-states';

// An imp provider's broker host over a stub imp port, which reaches
// impd's features and secrets alone.
function setupTest() {
  const tmp = setupTempDir('atc-oauth-states-');
  const port = createStubImpPort();

  const provider = new ImpProvider(port, { guestDir: join(tmp.dir, 'g') }, { atcBinary: null });

  registerTestCleanup(() => {
    provider.dispose();
  });

  return { port, host: provider.brokerAuth };
}

test('it reads nothing from impd for a binding without an oauth secret', async () => {
  const ctx = setupTest();

  const states = await loadOAuthStates(
    ctx.host,
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
  expect(ctx.port.calls).toStrictEqual([]);
});

test("it reads each bound oauth secret's sign-in state from impd's features and one secret list", async () => {
  const ctx = setupTest();

  ctx.port.createSecret(
    'codex-chatgpt',
    'oauth',
    [{ host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' }],
    { status: 'ready', idClaims: { email: 'someone@example.com' } },
  );

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  const states = await loadOAuthStates(
    ctx.host,
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

  expect(ctx.port.calls).toStrictEqual(['system.info', 'secrets.list']);
});

test('it refuses an impd without oauth secrets before it lists any secret', () => {
  const ctx = setupTest();

  ctx.port.features = { ...ctx.port.features, oauthSecrets: false };

  const loaded = loadOAuthStates(
    ctx.host,
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

  expect(ctx.port.calls).toStrictEqual(['system.info']);
});

test('it refuses a bound oauth secret that impd does not hold', () => {
  const ctx = setupTest();

  const loaded = loadOAuthStates(
    ctx.host,
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
  const ctx = setupTest();

  ctx.port.createSecret('codex-chatgpt', 'custom', [
    { host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' },
  ]);

  const loaded = loadOAuthStates(
    ctx.host,
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
  const ctx = setupTest();

  ctx.port.setFeatureFailures(1);

  const loaded = loadOAuthStates(
    ctx.host,
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
