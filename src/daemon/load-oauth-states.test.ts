import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { FixtureImpPort } from '../test-utils/fixture-imp-port';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { ImpProvider } from './imp-provider';
import { loadOAuthStates } from './load-oauth-states';

// An imp provider's broker host over a fixture imp port, which reaches
// impd's features and secrets alone.
function setupTest() {
  using stack = new DisposableStack();

  const tmp = stack.use(setupTempDir('atc-oauth-states-'));
  const port = stack.use(new FixtureImpPort());

  const provider = new ImpProvider(port, { guestDir: join(tmp.dir, 'g') }, { atcBinary: null });

  stack.defer(() => {
    provider.dispose();
  });

  const owned = stack.move();

  return {
    port,
    host: provider.brokerAuth,
    [Symbol.dispose]: () => {
      owned.dispose();
    },
  };
}

test('it reads nothing from impd for a binding without an oauth secret', async () => {
  using ctx = setupTest();

  const states = await loadOAuthStates(ctx.host, {
    agent: 'codex',
    baseURL: 'https://chatgpt.com/backend-api/codex',
    profiles: ['glm'],
    secrets: [
      {
        secret: 'glm',
        kind: 'custom',
        rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
      },
    ],
    placeholderEnv: {},
    profileEnv: {},
    hash: 'h1',
  });

  expect({ states, calls: ctx.port.calls }).toStrictEqual({ states: undefined, calls: [] });
});

test("it reads each bound oauth secret's sign-in state from impd's features and one secret list", async () => {
  using ctx = setupTest();

  ctx.port.createSecret(
    'codex-chatgpt',
    'oauth',
    [{ host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' }],
    { status: 'ready', idClaims: { email: 'someone@example.com' } },
  );

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  const states = await loadOAuthStates(ctx.host, {
    agent: 'codex',
    baseURL: 'https://chatgpt.com/backend-api/codex',
    profiles: ['codex', 'glm'],
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
    placeholderEnv: {},
    profileEnv: {},
    hash: 'h1',
  });

  expect({ states, calls: ctx.port.calls }).toStrictEqual({
    states: { 'codex-chatgpt': { status: 'ready', idClaims: { email: 'someone@example.com' } } },
    calls: ['system.info', 'secrets.list'],
  });
});

test('it refuses an impd without oauth secrets before it lists any secret', () => {
  using ctx = setupTest();

  ctx.port.features = { ...ctx.port.features, oauthSecrets: false };

  const loaded = loadOAuthStates(ctx.host, {
    agent: 'codex',
    baseURL: 'https://chatgpt.com/backend-api/codex',
    profiles: ['codex'],
    secrets: [
      {
        secret: 'codex-chatgpt',
        kind: 'oauth',
        rules: [{ host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' }],
      },
    ],
    placeholderEnv: {},
    profileEnv: {},
    hash: 'h1',
  });

  expect(loaded).rejects.toMatchObject({
    code: 'auth_impd_too_old',
    message: 'impd lacks oauth secret support, which codex-chatgpt needs',
  });

  expect(ctx.port.calls).toStrictEqual(['system.info']);
});

test('it refuses a bound oauth secret that impd does not hold', () => {
  using ctx = setupTest();

  const loaded = loadOAuthStates(ctx.host, {
    agent: 'codex',
    baseURL: 'https://chatgpt.com/backend-api/codex',
    profiles: ['codex'],
    secrets: [
      {
        secret: 'codex-chatgpt',
        kind: 'oauth',
        rules: [{ host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' }],
      },
    ],
    placeholderEnv: {},
    profileEnv: {},
    hash: 'h1',
  });

  expect(loaded).rejects.toMatchObject({ code: 'auth_secret_mismatch' });
});

test('it refuses a bound oauth secret that impd holds as another kind', () => {
  using ctx = setupTest();

  ctx.port.createSecret('codex-chatgpt', 'custom', [
    { host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' },
  ]);

  const loaded = loadOAuthStates(ctx.host, {
    agent: 'codex',
    baseURL: 'https://chatgpt.com/backend-api/codex',
    profiles: ['codex'],
    secrets: [
      {
        secret: 'codex-chatgpt',
        kind: 'oauth',
        rules: [{ host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' }],
      },
    ],
    placeholderEnv: {},
    profileEnv: {},
    hash: 'h1',
  });

  expect(loaded).rejects.toMatchObject({ code: 'auth_secret_mismatch' });
});

test('it turns a call impd fails into an unavailable host', () => {
  using ctx = setupTest();

  ctx.port.setFeatureFailures(1);

  const loaded = loadOAuthStates(ctx.host, {
    agent: 'codex',
    baseURL: 'https://chatgpt.com/backend-api/codex',
    profiles: ['codex'],
    secrets: [
      {
        secret: 'codex-chatgpt',
        kind: 'oauth',
        rules: [{ host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' }],
      },
    ],
    placeholderEnv: {},
    profileEnv: {},
    hash: 'h1',
  });

  expect(loaded).rejects.toMatchObject({
    code: 'host_unavailable',
    data: { provider: 'imp', problem: 'unreachable' },
  });
});
