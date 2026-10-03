import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { FixtureImpPort } from '../../test/fixture-imp-port';
import { setupTempDir } from '../../test/setup-temp-dir';
import { toSessionID } from '../shared/to-session-id';
import { StateStore } from '../store/state-store';
import { ImpProvider } from './imp-provider';
import { RuntimeAuthBinder } from './runtime-auth-binder';

// A binder over a real state store and an imp provider on a fixture imp
// port, whose impd an operator prepared: the token `atc-runtime` manages
// `atc-*` imps and may grant `glm` and `judge`, and impd holds `glm` for
// api.z.ai and `judge` for judge.example, both custom bearer secrets.
async function setupTest() {
  const tmp = setupTempDir('atc-auth-binder-');

  const store = await StateStore.open(join(tmp.dir, 'state.db'));

  const port = new FixtureImpPort();
  const provider = new ImpProvider(port, { guestDir: join(tmp.dir, 'g') }, { atcBinary: null });

  port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  return {
    store,
    port,
    host: provider.brokerAuth,
    binder: new RuntimeAuthBinder(store),
    async [Symbol.asyncDispose]() {
      provider.dispose();
      port[Symbol.dispose]();

      await store.stop();

      tmp[Symbol.dispose]();
    },
  };
}

test('it provisions a host through the gate, the record, a new imp and each grant, in that order', async () => {
  await using auth = await setupTest();

  const attemptID = await auth.binder.createBinding(auth.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: {
      agent: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      placeholderEnv: {},
      hash: 'h1',
    },
  });

  expect(auth.port.calls).toStrictEqual([
    'system.info',
    'tokens.whoami',
    'secrets.list',
    'imps.get atc-s1',
    'imps.create atc-s1',
    'grants.list atc-s1',
    'grants.add atc-s1 glm',
  ]);

  const binding = await auth.store.findAuthBinding(toSessionID('s1'));
  const grants = await auth.store.collectAuthGrants(toSessionID('s1'));
  const imp = await auth.port.readImp('atc-s1');

  expect<Record<string, unknown>>({ binding, grants }).toStrictEqual({
    binding: expect.objectContaining({
      impName: 'atc-s1',
      impID: imp?.id,
      revision: 1,
      bindingHash: 'h1',
      state: 'provisioning',
      attemptID,
      impCreatedByAttempt: true,
    }),
    grants: [
      expect.objectContaining({
        secret: 'glm',
        revision: 1,
        attemptID,
        preexisting: false,
        phase: 'granted',
      }),
    ],
  });
});

test('it refuses an impd without exec requirements after reading only its features and records nothing', async () => {
  await using auth = await setupTest();

  auth.port.features = { ...auth.port.features, execRequire: false };

  const created = auth.binder.createBinding(auth.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: {
      agent: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      placeholderEnv: {},
      hash: 'h1',
    },
  });

  expect(created).rejects.toMatchObject({
    code: 'auth_impd_too_old',
    data: { execRequire: false },
  });

  await created.catch(() => null);

  expect<Record<string, unknown>>({
    calls: [...auth.port.calls],
    binding: await auth.store.findAuthBinding(toSessionID('s1')),
  }).toStrictEqual({ calls: ['system.info'], binding: null });
});

test('it refuses a token that reaches every imp and records nothing', async () => {
  await using auth = await setupTest();

  auth.port.setIdentity({
    kind: 'token',
    name: 'host-wide',
    scope: 'manage',
    imps: null,
    grantable: ['glm'],
  });

  const created = auth.binder.createBinding(auth.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: {
      agent: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      placeholderEnv: {},
      hash: 'h1',
    },
  });

  expect(created).rejects.toMatchObject({ code: 'auth_token_too_broad' });

  await created.catch(() => null);

  expect<Record<string, unknown>>({
    calls: [...auth.port.calls],
    binding: await auth.store.findAuthBinding(toSessionID('s1')),
  }).toStrictEqual({ calls: ['system.info', 'tokens.whoami'], binding: null });
});

test('it refuses a secret whose rules differ from the binding and creates no imp', async () => {
  await using auth = await setupTest();

  auth.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
    { host: 'elsewhere.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const created = auth.binder.createBinding(auth.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: {
      agent: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      placeholderEnv: {},
      hash: 'h1',
    },
  });

  expect(created).rejects.toMatchObject({ code: 'auth_secret_mismatch' });

  await created.catch(() => null);

  expect<Record<string, unknown>>({
    calls: [...auth.port.calls],
    binding: await auth.store.findAuthBinding(toSessionID('s1')),
  }).toStrictEqual({
    calls: ['system.info', 'tokens.whoami', 'secrets.list'],
    binding: null,
  });
});

test('it refuses an imp that already holds the name and grants nothing to it', async () => {
  await using auth = await setupTest();

  await auth.port.createImp({ name: 'atc-s1' });

  const created = auth.binder.createBinding(auth.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: {
      agent: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      placeholderEnv: {},
      hash: 'h1',
    },
  });

  expect(created).rejects.toMatchObject({ code: 'auth_runtime_exists' });

  await created.catch(() => null);

  expect<Record<string, unknown>>({
    calls: [...auth.port.calls],
    grants: await auth.port.readGrants('atc-s1'),
    binding: await auth.store.findAuthBinding(toSessionID('s1')),
  }).toStrictEqual({
    calls: [
      'imps.create atc-s1',
      'system.info',
      'tokens.whoami',
      'secrets.list',
      'imps.get atc-s1',
    ],
    grants: [],
    binding: null,
  });
});

test('it takes back the imp a refused grant left and drops the record', async () => {
  await using auth = await setupTest();

  // A rebind of the secret's rules leaves the token's grantable list behind.
  auth.port.updateSecret('glm', [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }]);

  const created = auth.binder.createBinding(auth.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: {
      agent: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      placeholderEnv: {},
      hash: 'h1',
    },
  });

  expect(created).rejects.toMatchObject({
    code: 'host_unavailable',
    data: { problem: 'forbidden' },
  });

  await created.catch(() => null);

  expect<Record<string, unknown>>({
    calls: auth.port.calls.slice(4),
    imps: auth.port.collectImpNames(),
    binding: await auth.store.findAuthBinding(toSessionID('s1')),
  }).toStrictEqual({
    calls: [
      'imps.create atc-s1',
      'grants.list atc-s1',
      'grants.add atc-s1 glm',
      'tokens.whoami',
      'imps.get atc-s1',
      'imps.destroy atc-s1',
      'imps.get atc-s1',
    ],
    imps: [],
    binding: null,
  });
});

test('it verifies a bound host without granting anything again', async () => {
  await using auth = await setupTest();

  const attemptID = await auth.binder.createBinding(auth.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: {
      agent: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      placeholderEnv: {},
      hash: 'h1',
    },
  });

  await auth.binder.updateReady(toSessionID('s1'), attemptID);

  auth.port.calls.length = 0;

  const verified = await auth.binder.verifyBinding(auth.host, toSessionID('s1'), {
    agent: 'glm',
    baseURL: 'https://api.z.ai/api/anthropic',
    profiles: ['glm'],
    secrets: [
      {
        secret: 'glm',
        kind: 'custom',
        rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
      },
    ],
    placeholderEnv: {},
    hash: 'h1',
  });

  expect<Record<string, unknown>>({ state: verified.state, calls: auth.port.calls }).toStrictEqual({
    state: 'ready',
    calls: [
      'system.info',
      'tokens.whoami',
      'secrets.list',
      'imps.get atc-s1',
      'grants.list atc-s1',
    ],
  });
});

test('it refuses a host whose grant was revoked outside atc and grants it no more', async () => {
  await using auth = await setupTest();

  const attemptID = await auth.binder.createBinding(auth.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: {
      agent: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      placeholderEnv: {},
      hash: 'h1',
    },
  });

  await auth.binder.updateReady(toSessionID('s1'), attemptID);
  await auth.port.removeGrant('atc-s1', 'glm');

  auth.port.calls.length = 0;

  const verified = auth.binder.verifyBinding(auth.host, toSessionID('s1'), {
    agent: 'glm',
    baseURL: 'https://api.z.ai/api/anthropic',
    profiles: ['glm'],
    secrets: [
      {
        secret: 'glm',
        kind: 'custom',
        rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
      },
    ],
    placeholderEnv: {},
    hash: 'h1',
  });

  expect(verified).rejects.toMatchObject({
    code: 'auth_grant_missing',
    data: { missing: ['glm'] },
  });

  await verified.catch(() => null);

  expect(auth.port.calls).not.toContain('grants.add atc-s1 glm');
});

test('it refuses a host that holds a grant its binding does not', async () => {
  await using auth = await setupTest();

  const attemptID = await auth.binder.createBinding(auth.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: {
      agent: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      placeholderEnv: {},
      hash: 'h1',
    },
  });

  await auth.binder.updateReady(toSessionID('s1'), attemptID);
  await auth.port.createGrant('atc-s1', 'judge');

  const verified = auth.binder.verifyBinding(auth.host, toSessionID('s1'), {
    agent: 'glm',
    baseURL: 'https://api.z.ai/api/anthropic',
    profiles: ['glm'],
    secrets: [
      {
        secret: 'glm',
        kind: 'custom',
        rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
      },
    ],
    placeholderEnv: {},
    hash: 'h1',
  });

  expect(verified).rejects.toMatchObject({
    code: 'auth_grants_mismatch',
    data: { extra: ['judge'] },
  });

  await verified.catch(() => null);

  const grants = await auth.port.readGrants('atc-s1');

  expect(grants).toStrictEqual(['glm', 'judge']);
});

test('it refuses a host whose used profiles changed before it reaches impd', async () => {
  await using auth = await setupTest();

  const attemptID = await auth.binder.createBinding(auth.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: {
      agent: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      placeholderEnv: {},
      hash: 'h1',
    },
  });

  await auth.binder.updateReady(toSessionID('s1'), attemptID);

  auth.port.calls.length = 0;

  const verified = auth.binder.verifyBinding(auth.host, toSessionID('s1'), {
    agent: 'glm',
    baseURL: 'https://api.z.ai/api/anthropic',
    profiles: ['glm'],
    secrets: [
      {
        secret: 'glm',
        kind: 'custom',
        rules: [{ host: 'api.z.ai', header: 'x-api-key', scheme: 'bearer' }],
      },
    ],
    placeholderEnv: {},
    hash: 'h2',
  });

  expect(verified).rejects.toMatchObject({ code: 'auth_rebind_required' });

  await verified.catch(() => null);

  expect(auth.port.calls).toStrictEqual([]);
});

test('it refuses an imp made again under the recorded name', async () => {
  await using auth = await setupTest();

  const attemptID = await auth.binder.createBinding(auth.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: {
      agent: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      placeholderEnv: {},
      hash: 'h1',
    },
  });

  await auth.binder.updateReady(toSessionID('s1'), attemptID);
  await auth.port.destroyImp('atc-s1');
  await auth.port.createImp({ name: 'atc-s1' });
  await auth.port.createGrant('atc-s1', 'glm');

  const verified = auth.binder.verifyBinding(auth.host, toSessionID('s1'), {
    agent: 'glm',
    baseURL: 'https://api.z.ai/api/anthropic',
    profiles: ['glm'],
    secrets: [
      {
        secret: 'glm',
        kind: 'custom',
        rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
      },
    ],
    placeholderEnv: {},
    hash: 'h1',
  });

  expect(verified).rejects.toMatchObject({ code: 'auth_runtime_mismatch' });
});

test('it revokes every grant through the identity checks alone, without reading any secret', async () => {
  await using auth = await setupTest();

  const attemptID = await auth.binder.createBinding(auth.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: {
      agent: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      placeholderEnv: {},
      hash: 'h1',
    },
  });

  await auth.binder.updateReady(toSessionID('s1'), attemptID);

  // A rule change on the host side never stops a revoke.
  auth.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'x-api-key', scheme: 'bearer' },
  ]);

  auth.port.calls.length = 0;

  await auth.binder.revokeBinding(auth.host, toSessionID('s1'));

  expect<Record<string, unknown>>({
    calls: [...auth.port.calls],
    grants: await auth.port.readGrants('atc-s1'),
    binding: await auth.store.findAuthBinding(toSessionID('s1')),
    rows: await auth.store.collectAuthGrants(toSessionID('s1')),
  }).toStrictEqual({
    calls: ['tokens.whoami', 'imps.get atc-s1', 'grants.delete atc-s1 glm'],
    grants: [],
    binding: expect.objectContaining({ state: 'revoked', revokedAt: expect.toBeNumber() }),
    rows: [expect.objectContaining({ secret: 'glm', phase: 'revoked' })],
  });
});

test('it blocks every launch on a host once its grants are revoked', async () => {
  await using auth = await setupTest();

  const attemptID = await auth.binder.createBinding(auth.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: {
      agent: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      placeholderEnv: {},
      hash: 'h1',
    },
  });

  await auth.binder.updateReady(toSessionID('s1'), attemptID);
  await auth.binder.revokeBinding(auth.host, toSessionID('s1'));

  auth.port.calls.length = 0;

  const verified = auth.binder.verifyBinding(auth.host, toSessionID('s1'), {
    agent: 'glm',
    baseURL: 'https://api.z.ai/api/anthropic',
    profiles: ['glm'],
    secrets: [
      {
        secret: 'glm',
        kind: 'custom',
        rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
      },
    ],
    placeholderEnv: {},
    hash: 'h1',
  });

  expect(verified).rejects.toMatchObject({ code: 'auth_blocked', data: { state: 'revoked' } });

  await verified.catch(() => null);

  expect(auth.port.calls).toStrictEqual([]);
});

test('it records the block of a revoke and keeps it pending when impd cannot be reached', async () => {
  await using auth = await setupTest();

  const attemptID = await auth.binder.createBinding(auth.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: {
      agent: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      placeholderEnv: {},
      hash: 'h1',
    },
  });

  await auth.binder.updateReady(toSessionID('s1'), attemptID);

  const revoked = auth.binder.revokeBinding(null, toSessionID('s1'));

  expect(revoked).rejects.toMatchObject({
    code: 'auth_revocation_pending',
    data: { pending: ['glm'] },
  });

  await revoked.catch(() => null);

  expect<Record<string, unknown>>({
    binding: await auth.store.findAuthBinding(toSessionID('s1')),
    rows: await auth.store.collectAuthGrants(toSessionID('s1')),
  }).toStrictEqual({
    binding: expect.objectContaining({ state: 'revocation_pending', revokedAt: null }),
    rows: [expect.objectContaining({ secret: 'glm', phase: 'revocation_pending' })],
  });
});

test('it counts a grant a secret rebind already dropped as revoked though the token can no longer revoke it', async () => {
  await using auth = await setupTest();

  const attemptID = await auth.binder.createBinding(auth.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: {
      agent: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      placeholderEnv: {},
      hash: 'h1',
    },
  });

  await auth.binder.updateReady(toSessionID('s1'), attemptID);

  auth.port.updateSecret('glm', [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }]);

  await auth.binder.revokeBinding(auth.host, toSessionID('s1'));

  const binding = await auth.store.findAuthBinding(toSessionID('s1'));

  expect(binding).toMatchObject({ state: 'revoked' });
});

test('it keeps a revoke pending when the token cannot revoke a grant impd still holds', async () => {
  await using auth = await setupTest();

  const attemptID = await auth.binder.createBinding(auth.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: {
      agent: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      placeholderEnv: {},
      hash: 'h1',
    },
  });

  await auth.binder.updateReady(toSessionID('s1'), attemptID);

  auth.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: [],
  });

  const revoked = auth.binder.revokeBinding(auth.host, toSessionID('s1'));

  expect(revoked).rejects.toMatchObject({ code: 'auth_revocation_pending' });

  await revoked.catch(() => null);

  expect<Record<string, unknown>>({
    grants: await auth.port.readGrants('atc-s1'),
    binding: await auth.store.findAuthBinding(toSessionID('s1')),
  }).toStrictEqual({
    grants: ['glm'],
    binding: expect.objectContaining({ state: 'revocation_pending' }),
  });
});

test('it rebinds a host to the next revision, granting the new secret and revoking the dropped one', async () => {
  await using auth = await setupTest();

  const attemptID = await auth.binder.createBinding(auth.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: {
      agent: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      placeholderEnv: {},
      hash: 'h1',
    },
  });

  await auth.binder.updateReady(toSessionID('s1'), attemptID);

  auth.port.calls.length = 0;

  const revision = await auth.binder.updateBinding(auth.host, toSessionID('s1'), {
    agent: 'glm',
    baseURL: 'https://judge.example',
    profiles: ['judge'],
    secrets: [
      {
        secret: 'judge',
        kind: 'custom',
        rules: [{ host: 'judge.example', header: 'authorization', scheme: 'bearer' }],
      },
    ],
    placeholderEnv: {},
    hash: 'h2',
  });

  expect<Record<string, unknown>>({
    revision,
    calls: [...auth.port.calls],
    grants: await auth.port.readGrants('atc-s1'),
    binding: await auth.store.findAuthBinding(toSessionID('s1')),
  }).toStrictEqual({
    revision: 2,
    calls: [
      'system.info',
      'tokens.whoami',
      'secrets.list',
      'tokens.whoami',
      'imps.get atc-s1',
      'grants.list atc-s1',
      'grants.add atc-s1 judge',
      'grants.delete atc-s1 glm',
    ],
    grants: ['judge'],
    binding: expect.objectContaining({
      state: 'ready',
      revision: 2,
      bindingHash: 'h2',
      rebind: null,
    }),
  });
});

test('it removes only the grants a failed rebind added and keeps the imp at the old revision', async () => {
  await using auth = await setupTest();

  const attemptID = await auth.binder.createBinding(auth.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: {
      agent: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      placeholderEnv: {},
      hash: 'h1',
    },
  });

  await auth.binder.updateReady(toSessionID('s1'), attemptID);

  auth.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge', 'zeta'],
  });

  // Recreated after the token was made, so the token's list no longer
  // covers it and impd refuses its grant.
  auth.port.createSecret('zeta', 'custom', [
    { host: 'zeta.example', header: 'authorization', scheme: 'bearer' },
  ]);

  auth.port.removeSecret('zeta');

  auth.port.createSecret('zeta', 'custom', [
    { host: 'zeta.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const rebound = auth.binder.updateBinding(auth.host, toSessionID('s1'), {
    agent: 'glm',
    baseURL: 'https://api.z.ai/api/anthropic',
    profiles: ['glm', 'judge', 'zeta'],
    secrets: [
      {
        secret: 'glm',
        kind: 'custom',
        rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
      },
      {
        secret: 'judge',
        kind: 'custom',
        rules: [{ host: 'judge.example', header: 'authorization', scheme: 'bearer' }],
      },
      {
        secret: 'zeta',
        kind: 'custom',
        rules: [{ host: 'zeta.example', header: 'authorization', scheme: 'bearer' }],
      },
    ],
    placeholderEnv: {},
    hash: 'h2',
  });

  expect(rebound).rejects.toMatchObject({ code: 'host_unavailable' });

  await rebound.catch(() => null);

  expect<Record<string, unknown>>({
    imps: auth.port.collectImpNames(),
    grants: await auth.port.readGrants('atc-s1'),
    binding: await auth.store.findAuthBinding(toSessionID('s1')),
  }).toMatchObject({
    imps: ['atc-s1'],
    grants: ['glm'],
    binding: {
      state: 'rebind_failed',
      revision: 1,
      bindingHash: 'h1',
      rebind: { revision: 2, bindingHash: 'h2' },
    },
  });
});

test('it takes back one attempt without touching the imp or grants of another host', async () => {
  await using auth = await setupTest();

  const first = await auth.binder.createBinding(auth.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: {
      agent: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      placeholderEnv: {},
      hash: 'h1',
    },
  });

  await auth.binder.createBinding(auth.host, {
    hostKey: toSessionID('s2'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: {
      agent: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      placeholderEnv: {},
      hash: 'h1',
    },
  });

  auth.port.calls.length = 0;

  await auth.binder.removeAttempt(auth.host, toSessionID('s1'), first);

  expect<Record<string, unknown>>({
    calls: [...auth.port.calls],
    imps: auth.port.collectImpNames(),
    grants: await auth.port.readGrants('atc-s2'),
    first: await auth.store.findAuthBinding(toSessionID('s1')),
    second: await auth.store.findAuthBinding(toSessionID('s2')),
  }).toStrictEqual({
    calls: ['tokens.whoami', 'imps.get atc-s1', 'imps.destroy atc-s1', 'imps.get atc-s1'],
    imps: ['atc-s2'],
    grants: ['glm'],
    first: null,
    second: expect.objectContaining({ hostKey: 's2', state: 'provisioning' }),
  });
});

test('it leaves a host alone when asked to take back an attempt other than the one it holds', async () => {
  await using auth = await setupTest();

  await auth.binder.createBinding(auth.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: {
      agent: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      placeholderEnv: {},
      hash: 'h1',
    },
  });

  auth.port.calls.length = 0;

  await auth.binder.removeAttempt(auth.host, toSessionID('s1'), 'another-attempt');

  expect<Record<string, unknown>>({
    calls: auth.port.calls,
    imps: auth.port.collectImpNames(),
  }).toStrictEqual({
    calls: [],
    imps: ['atc-s1'],
  });
});

test('it forgets a bound host by destroying its imp and dropping the record', async () => {
  await using auth = await setupTest();

  const attemptID = await auth.binder.createBinding(auth.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: {
      agent: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      placeholderEnv: {},
      hash: 'h1',
    },
  });

  await auth.binder.updateReady(toSessionID('s1'), attemptID);

  auth.port.calls.length = 0;

  const forgotten = await auth.binder.forgetBinding(auth.host, toSessionID('s1'));

  const calls = [...auth.port.calls];

  const secrets = await auth.port.readSecrets();

  expect<Record<string, unknown>>({
    forgotten,
    calls,
    imps: auth.port.collectImpNames(),
    secrets: secrets.map((secret) => secret.name),
    binding: await auth.store.findAuthBinding(toSessionID('s1')),
  }).toStrictEqual({
    forgotten: true,
    calls: ['tokens.whoami', 'imps.get atc-s1', 'imps.destroy atc-s1', 'imps.get atc-s1'],
    imps: [],
    secrets: ['glm', 'judge'],
    binding: null,
  });
});

test('it refuses to forget a host whose imp was made again and leaves that imp alone', async () => {
  await using auth = await setupTest();

  const attemptID = await auth.binder.createBinding(auth.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: {
      agent: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      placeholderEnv: {},
      hash: 'h1',
    },
  });

  await auth.binder.updateReady(toSessionID('s1'), attemptID);
  await auth.port.destroyImp('atc-s1');
  await auth.port.createImp({ name: 'atc-s1' });

  const forgotten = auth.binder.forgetBinding(auth.host, toSessionID('s1'));

  expect(forgotten).rejects.toMatchObject({ code: 'auth_revocation_pending' });

  await forgotten.catch(() => null);

  expect<Record<string, unknown>>({
    imps: auth.port.collectImpNames(),
    binding: await auth.store.findAuthBinding(toSessionID('s1')),
  }).toStrictEqual({
    imps: ['atc-s1'],
    binding: expect.objectContaining({ state: 'revocation_pending' }),
  });
});

test('it takes back a provisioning attempt no fleet entry lists as a daemon starts, and leaves a listed host alone', async () => {
  await using auth = await setupTest();

  for (const hostKey of ['s1', 's2']) {
    await auth.binder.createBinding(auth.host, {
      hostKey: toSessionID(hostKey),
      target: 'box',
      targetIdentity: 'imp:test',
      binding: {
        agent: 'glm',
        baseURL: 'https://api.z.ai/api/anthropic',
        profiles: ['glm'],
        secrets: [
          {
            secret: 'glm',
            kind: 'custom',
            rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
          },
        ],
        placeholderEnv: {},
        hash: 'h1',
      },
    });
  }

  const logged: string[] = [];

  await auth.binder.reconcileBindings(
    (target) => (target === 'box' ? auth.host : null),
    new Set([toSessionID('s2')]),
    (line) => {
      logged.push(line);
    },
  );

  expect<Record<string, unknown>>({
    logged,
    imps: auth.port.collectImpNames(),
    first: await auth.store.findAuthBinding(toSessionID('s1')),
    second: await auth.store.findAuthBinding(toSessionID('s2')),
  }).toStrictEqual({
    logged: [],
    imps: ['atc-s2'],
    first: null,
    second: expect.objectContaining({ state: 'provisioning' }),
  });
});

test('it fails a rebind a stopped daemon left in flight and revokes only the grants it added', async () => {
  await using auth = await setupTest();

  const attemptID = await auth.binder.createBinding(auth.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: {
      agent: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      placeholderEnv: {},
      hash: 'h1',
    },
  });

  await auth.binder.updateReady(toSessionID('s1'), attemptID);

  await auth.store.updateAuthBinding(
    toSessionID('s1'),
    {
      state: 'provisioning',
      rebind: { revision: 2, bindingHash: 'h2', bindingJSON: '{}', attemptID: 'rebind-1' },
    },
    2000,
  );

  await auth.store.upsertAuthGrant(
    {
      hostKey: toSessionID('s1'),
      secret: 'judge',
      revision: 2,
      attemptID: 'rebind-1',
      preexisting: false,
      phase: 'granted',
    },
    2000,
  );

  await auth.port.createGrant('atc-s1', 'judge');

  await auth.binder.reconcileBindings(
    () => auth.host,
    new Set([toSessionID('s1')]),
    () => {},
  );

  expect<Record<string, unknown>>({
    grants: await auth.port.readGrants('atc-s1'),
    binding: await auth.store.findAuthBinding(toSessionID('s1')),
  }).toStrictEqual({
    grants: ['glm'],
    binding: expect.objectContaining({ state: 'rebind_failed', revision: 1 }),
  });
});

test('it rebinds a provisioned host whose spawn listed but never recorded its start', async () => {
  await using auth = await setupTest();

  await auth.binder.createBinding(auth.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: {
      agent: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      placeholderEnv: {},
      hash: 'h1',
    },
  });

  const revision = await auth.binder.updateBinding(auth.host, toSessionID('s1'), {
    agent: 'glm',
    baseURL: 'https://api.z.ai/api/anthropic',
    profiles: ['glm'],
    secrets: [
      {
        secret: 'glm',
        kind: 'custom',
        rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
      },
    ],
    placeholderEnv: {},
    hash: 'h1',
  });

  const binding = await auth.store.findAuthBinding(toSessionID('s1'));

  expect<Record<string, unknown>>({ revision, binding }).toMatchObject({
    revision: 2,
    binding: { state: 'ready', revision: 2, rebind: null },
  });
});

test('it refuses to rebind a host whose spawn is still provisioning before it created the imp', async () => {
  await using auth = await setupTest();

  await auth.store.createAuthBinding(
    {
      hostKey: toSessionID('s1'),
      target: 'box',
      targetIdentity: 'imp:test',
      impName: 'atc-s1',
      bindingHash: 'h1',
      bindingJSON: '{"secrets":[]}',
      attemptID: 'attempt-1',
    },
    1000,
  );

  const rebound = auth.binder.updateBinding(auth.host, toSessionID('s1'), {
    agent: 'glm',
    baseURL: 'https://api.z.ai/api/anthropic',
    profiles: ['glm'],
    secrets: [
      {
        secret: 'glm',
        kind: 'custom',
        rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
      },
    ],
    placeholderEnv: {},
    hash: 'h1',
  });

  expect(rebound).rejects.toMatchObject({ code: 'auth_blocked', data: { state: 'provisioning' } });
});

test('it refuses to take back an attempt through a target whose imp prefix changed, and destroys no imp', async () => {
  await using auth = await setupTest();

  const attemptID = await auth.binder.createBinding(auth.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: {
      agent: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      placeholderEnv: {},
      hash: 'h1',
    },
  });

  await auth.port.createImp({ name: 'atc-new-s1' });

  const renamed = new ImpProvider(auth.port, { impPrefix: 'atc-new-' }, { atcBinary: null });

  const removed = auth.binder.removeAttempt(renamed.brokerAuth, toSessionID('s1'), attemptID);

  expect(removed).rejects.toThrow('atc could not take back the runtime auth of host s1');

  await removed.catch(() => null);

  expect<Record<string, unknown>>({
    imps: auth.port.collectImpNames().toSorted(),
    binding: await auth.store.findAuthBinding(toSessionID('s1')),
  }).toMatchObject({ imps: ['atc-new-s1', 'atc-s1'], binding: { state: 'rollback_pending' } });
});

test('it retries the removal of the grants a failed rebind added on a later start once impd is reachable', async () => {
  await using auth = await setupTest();

  const attemptID = await auth.binder.createBinding(auth.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: {
      agent: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      placeholderEnv: {},
      hash: 'h1',
    },
  });

  await auth.binder.updateReady(toSessionID('s1'), attemptID);

  await auth.store.updateAuthBinding(
    toSessionID('s1'),
    {
      state: 'provisioning',
      rebind: { revision: 2, bindingHash: 'h2', bindingJSON: '{}', attemptID: 'rebind-1' },
    },
    2000,
  );

  await auth.store.upsertAuthGrant(
    {
      hostKey: toSessionID('s1'),
      secret: 'judge',
      revision: 2,
      attemptID: 'rebind-1',
      preexisting: false,
      phase: 'granted',
    },
    2000,
  );

  await auth.port.createGrant('atc-s1', 'judge');

  await auth.binder.reconcileBindings(
    () => null,
    new Set([toSessionID('s1')]),
    () => {},
  );

  const unreached = await auth.port.readGrants('atc-s1');

  await auth.binder.reconcileBindings(
    () => auth.host,
    new Set([toSessionID('s1')]),
    () => {},
  );

  expect<Record<string, unknown>>({
    unreached,
    grants: await auth.port.readGrants('atc-s1'),
    binding: await auth.store.findAuthBinding(toSessionID('s1')),
  }).toMatchObject({
    unreached: ['glm', 'judge'],
    grants: ['glm'],
    binding: { state: 'rebind_failed', revision: 1 },
  });
});

test('it hands a launch over before a revoke that arrives during its admission, which then completes', async () => {
  await using auth = await setupTest();

  const attemptID = await auth.binder.createBinding(auth.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: {
      agent: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      placeholderEnv: {},
      hash: 'h1',
    },
  });

  await auth.binder.updateReady(toSessionID('s1'), attemptID);

  const order: string[] = [];
  const revoked: Promise<void>[] = [];

  await auth.binder.withLaunchAdmission(
    toSessionID('s1'),
    { revision: 1, hash: 'h1', attemptID: null },
    'start',
    () => {
      revoked.push(auth.binder.revokeBinding(auth.host, toSessionID('s1')));
      order.push('sent');
    },
  );

  await Promise.all(revoked);

  order.push('revoked');

  expect<Record<string, unknown>>({
    order,
    binding: await auth.store.findAuthBinding(toSessionID('s1')),
  }).toStrictEqual({
    order: ['sent', 'revoked'],
    binding: expect.objectContaining({ state: 'revoked' }),
  });
});

test('it refuses a launch whose admission waits behind a revoke, handing nothing over', async () => {
  await using auth = await setupTest();

  const attemptID = await auth.binder.createBinding(auth.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: {
      agent: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      placeholderEnv: {},
      hash: 'h1',
    },
  });

  await auth.binder.updateReady(toSessionID('s1'), attemptID);

  const sent: string[] = [];
  const revoked = auth.binder.revokeBinding(auth.host, toSessionID('s1'));

  const admitted = auth.binder.withLaunchAdmission(
    toSessionID('s1'),
    { revision: 1, hash: 'h1', attemptID: null },
    'start',
    () => {
      sent.push('start');
    },
  );

  expect(admitted).rejects.toMatchObject({ code: 'auth_blocked', data: { state: 'revoked' } });

  await admitted.catch(() => null);

  await revoked;

  expect(sent).toStrictEqual([]);
});

test('it refuses a start planned under another binding hash than the ready one', async () => {
  await using auth = await setupTest();

  const attemptID = await auth.binder.createBinding(auth.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: {
      agent: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      placeholderEnv: {},
      hash: 'h1',
    },
  });

  await auth.binder.updateReady(toSessionID('s1'), attemptID);

  const sent: string[] = [];

  const admitted = auth.binder.withLaunchAdmission(
    toSessionID('s1'),
    { revision: 1, hash: 'h0', attemptID: null },
    'start',
    () => {
      sent.push('start');
    },
  );

  expect(admitted).rejects.toMatchObject({ code: 'auth_rebind_required' });

  await admitted.catch(() => null);

  expect(sent).toStrictEqual([]);
});
