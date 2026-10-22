import { expect, test } from 'bun:test';
import { buildMockAuthBinding } from '../testing/build-mock-auth-binding';
import { buildStubCredentialBroker } from '../testing/build-stub-credential-broker';
import { loadOAuthStates } from './load-oauth-states';

test('it reads nothing from the broker for a binding without an oauth secret', async () => {
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

test("it reads each bound oauth secret's sign-in state from one secret list once the broker's version passes", async () => {
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

test('it refuses an outdated broker as an unavailable host before it lists any secret', async () => {
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
    data: { provider: 'stub-remote', problem: 'outdated' },
  });

  await loaded.catch(() => {});

  expect(broker.calls).toStrictEqual(['verifyVersion']);
});

test("it ends an outdated broker's refusal with the broker's name and upgrade step", () => {
  const broker = {
    ...buildStubCredentialBroker(),
    describe: { name: 'harbor', upgrade: 'upgrade harbord to 4.0.0 or later' },
  };

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
    message:
      'the harbor broker refused a runtime auth call: the broker is older than the oldest this atc supports; upgrade harbord to 4.0.0 or later',
  });
});

test('it refuses a bound oauth secret that the broker does not hold', () => {
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

test('it refuses a bound oauth secret that the broker holds as another kind', () => {
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

test('it turns a call the broker fails into an unavailable host', () => {
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
    data: { provider: 'stub-remote', problem: 'unreachable' },
  });
});
