import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { toSessionID } from '../shared/to-session-id';
import { StateStore } from '../store/state-store';
import { buildMockAuthBinding } from '../test-utils/build-mock-auth-binding';
import { buildStubImpPort } from '../test-utils/build-stub-imp-port';
import { createMigratedStateDB } from '../test-utils/create-migrated-state-db';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { waitFor } from '../test-utils/wait-for';
import { EffectRemainsError } from './effect-remains-error';
import { ImpHarness } from './imp-harness';
import { ImpProvider } from './imp-provider';
import { RuntimeAuthBinder } from './runtime-auth-binder';

// A binder over a real state store, and an imp provider's broker host over
// a stub imp port, which the test prepares as an operator prepares impd.
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const tmp = stack.use(setupTempDir('atc-auth-binder-'));
  const dbPath = join(tmp.dir, 'state.db');

  await createMigratedStateDB(dbPath);

  const store = await StateStore.open(dbPath);

  stack.defer(() => store.stop());

  const port = stack.use(buildStubImpPort());

  const provider = new ImpProvider(port, { guestDir: join(tmp.dir, 'g') }, { atcBinary: null });

  stack.defer(() => {
    provider.dispose();
  });

  const owned = stack.move();

  return {
    dir: tmp.dir,
    store,
    port,
    host: provider.brokerAuth,
    binder: new RuntimeAuthBinder(store),
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it provisions a host through the gate, the record, a new imp and each grant, in that order', async () => {
  await using ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const attemptID = await ctx.binder.createBinding(ctx.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: buildMockAuthBinding({
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      hash: 'h1',
    }),
  });

  expect(ctx.port.calls).toStrictEqual([
    'system.info',
    'tokens.whoami',
    'secrets.list',
    'imps.get atc-s1',
    'imps.create atc-s1',
    'grants.list atc-s1',
    'grants.add atc-s1 glm',
  ]);

  const binding = await ctx.store.findAuthBinding(toSessionID('s1'));
  const grants = await ctx.store.collectAuthGrants(toSessionID('s1'));
  const imp = await ctx.port.readImp('atc-s1');

  invariant(imp);

  expect<Record<string, unknown>>({ binding, grants }).toStrictEqual({
    binding: expect.objectContaining({
      impName: 'atc-s1',
      impID: imp.id,
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
  await using ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.features = { ...ctx.port.features, execRequire: false };

  const created = ctx.binder.createBinding(ctx.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: buildMockAuthBinding({
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      hash: 'h1',
    }),
  });

  expect(created).rejects.toMatchObject({
    code: 'auth_impd_too_old',
    data: { execRequire: false },
  });

  expect<Record<string, unknown>>({
    calls: [...ctx.port.calls],
    binding: await ctx.store.findAuthBinding(toSessionID('s1')),
  }).toStrictEqual({ calls: ['system.info'], binding: null });
});

test('it refuses a token that reaches every imp and records nothing', async () => {
  await using ctx = await setupTest();

  // The token `host-wide` manages every imp, not only `atc-*` ones.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'host-wide',
    scope: 'manage',
    imps: null,
    grantable: ['glm'],
  });

  const created = ctx.binder.createBinding(ctx.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: buildMockAuthBinding({
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      hash: 'h1',
    }),
  });

  expect(created).rejects.toMatchObject({ code: 'auth_token_too_broad' });

  expect<Record<string, unknown>>({
    calls: [...ctx.port.calls],
    binding: await ctx.store.findAuthBinding(toSessionID('s1')),
  }).toStrictEqual({ calls: ['system.info', 'tokens.whoami'], binding: null });
});

test('it refuses a secret whose rules differ from the binding and creates no imp', async () => {
  await using ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `judge` for
  // judge.example and `glm` for api.z.ai and elsewhere.example, both custom
  // bearer secrets.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
    { host: 'elsewhere.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const created = ctx.binder.createBinding(ctx.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: buildMockAuthBinding({
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      hash: 'h1',
    }),
  });

  expect(created).rejects.toMatchObject({ code: 'auth_secret_mismatch' });

  expect<Record<string, unknown>>({
    calls: [...ctx.port.calls],
    binding: await ctx.store.findAuthBinding(toSessionID('s1')),
  }).toStrictEqual({
    calls: ['system.info', 'tokens.whoami', 'secrets.list'],
    binding: null,
  });
});

test('it refuses an imp that already holds the name and grants nothing to it', async () => {
  await using ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  await ctx.port.createImp({ name: 'atc-s1' });

  const created = ctx.binder.createBinding(ctx.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: buildMockAuthBinding({
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      hash: 'h1',
    }),
  });

  expect(created).rejects.toMatchObject({ code: 'auth_runtime_exists' });

  expect<Record<string, unknown>>({
    calls: [...ctx.port.calls],
    grants: await ctx.port.readGrants('atc-s1'),
    binding: await ctx.store.findAuthBinding(toSessionID('s1')),
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
  await using ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  // A rebind of the secret's rules leaves the token's grantable list behind.
  ctx.port.updateSecret('glm', [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }]);

  const created = ctx.binder.createBinding(ctx.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: buildMockAuthBinding({
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      hash: 'h1',
    }),
  });

  expect(created).rejects.toMatchObject({
    code: 'host_unavailable',
    data: { problem: 'forbidden' },
  });

  expect<Record<string, unknown>>({
    calls: ctx.port.calls,
    imps: ctx.port.collectImpNames(),
    binding: await ctx.store.findAuthBinding(toSessionID('s1')),
  }).toStrictEqual({
    calls: [
      'system.info',
      'tokens.whoami',
      'secrets.list',
      'imps.get atc-s1',
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
  await using ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const attemptID = await ctx.binder.createBinding(ctx.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: buildMockAuthBinding({
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      hash: 'h1',
    }),
  });

  await ctx.binder.updateReady(toSessionID('s1'), attemptID);

  ctx.port.calls.length = 0;

  const verified = await ctx.binder.verifyBinding(
    ctx.host,
    toSessionID('s1'),
    buildMockAuthBinding({
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      hash: 'h1',
    }),
  );

  expect<Record<string, unknown>>({ state: verified.state, calls: ctx.port.calls }).toStrictEqual({
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
  await using ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const attemptID = await ctx.binder.createBinding(ctx.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: buildMockAuthBinding({
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      hash: 'h1',
    }),
  });

  await ctx.binder.updateReady(toSessionID('s1'), attemptID);
  await ctx.port.removeGrant('atc-s1', 'glm');

  ctx.port.calls.length = 0;

  const verified = ctx.binder.verifyBinding(
    ctx.host,
    toSessionID('s1'),
    buildMockAuthBinding({
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      hash: 'h1',
    }),
  );

  expect(verified).rejects.toMatchObject({
    code: 'auth_grant_missing',
    data: { missing: ['glm'] },
  });

  expect(ctx.port.calls).toStrictEqual([
    'system.info',
    'tokens.whoami',
    'secrets.list',
    'imps.get atc-s1',
    'grants.list atc-s1',
  ]);
});

test('it refuses a host that holds a grant its binding does not', async () => {
  await using ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const attemptID = await ctx.binder.createBinding(ctx.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: buildMockAuthBinding({
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      hash: 'h1',
    }),
  });

  await ctx.binder.updateReady(toSessionID('s1'), attemptID);
  await ctx.port.createGrant('atc-s1', 'judge');

  const verified = ctx.binder.verifyBinding(
    ctx.host,
    toSessionID('s1'),
    buildMockAuthBinding({
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      hash: 'h1',
    }),
  );

  expect(verified).rejects.toMatchObject({
    code: 'auth_grants_mismatch',
    data: { extra: ['judge'] },
  });

  const grants = await ctx.port.readGrants('atc-s1');

  expect(grants).toStrictEqual(['glm', 'judge']);
});

test('it refuses a host whose used profiles changed before it reaches impd', async () => {
  await using ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const attemptID = await ctx.binder.createBinding(ctx.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: buildMockAuthBinding({
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      hash: 'h1',
    }),
  });

  await ctx.binder.updateReady(toSessionID('s1'), attemptID);

  ctx.port.calls.length = 0;

  const verified = ctx.binder.verifyBinding(
    ctx.host,
    toSessionID('s1'),
    buildMockAuthBinding({
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'x-api-key', scheme: 'bearer' }],
        },
      ],
      hash: 'h2',
    }),
  );

  expect(verified).rejects.toMatchObject({ code: 'auth_rebind_required' });
  expect(ctx.port.calls).toStrictEqual([]);
});

test('it refuses an imp made again under the recorded name', async () => {
  await using ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const attemptID = await ctx.binder.createBinding(ctx.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: buildMockAuthBinding({
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      hash: 'h1',
    }),
  });

  await ctx.binder.updateReady(toSessionID('s1'), attemptID);
  await ctx.port.destroyImp('atc-s1');
  await ctx.port.createImp({ name: 'atc-s1' });
  await ctx.port.createGrant('atc-s1', 'glm');

  const verified = ctx.binder.verifyBinding(
    ctx.host,
    toSessionID('s1'),
    buildMockAuthBinding({
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      hash: 'h1',
    }),
  );

  expect(verified).rejects.toMatchObject({ code: 'auth_runtime_mismatch' });
});

test('it revokes every grant through the identity checks alone, without reading any secret', async () => {
  await using ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const attemptID = await ctx.binder.createBinding(ctx.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: buildMockAuthBinding({
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      hash: 'h1',
    }),
  });

  await ctx.binder.updateReady(toSessionID('s1'), attemptID);

  // A rule change on the host side never stops a revoke.
  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'x-api-key', scheme: 'bearer' },
  ]);

  ctx.port.calls.length = 0;

  await ctx.binder.revokeBinding(ctx.host, toSessionID('s1'));

  expect<Record<string, unknown>>({
    calls: [...ctx.port.calls],
    grants: await ctx.port.readGrants('atc-s1'),
    binding: await ctx.store.findAuthBinding(toSessionID('s1')),
    rows: await ctx.store.collectAuthGrants(toSessionID('s1')),
  }).toStrictEqual({
    calls: ['tokens.whoami', 'imps.get atc-s1', 'grants.delete atc-s1 glm'],
    grants: [],
    binding: expect.objectContaining({ state: 'revoked', revokedAt: expect.toBeNumber() }),
    rows: [expect.objectContaining({ secret: 'glm', phase: 'revoked' })],
  });
});

test('it blocks every launch on a host once its grants are revoked', async () => {
  await using ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const attemptID = await ctx.binder.createBinding(ctx.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: buildMockAuthBinding({
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      hash: 'h1',
    }),
  });

  await ctx.binder.updateReady(toSessionID('s1'), attemptID);
  await ctx.binder.revokeBinding(ctx.host, toSessionID('s1'));

  ctx.port.calls.length = 0;

  const verified = ctx.binder.verifyBinding(
    ctx.host,
    toSessionID('s1'),
    buildMockAuthBinding({
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      hash: 'h1',
    }),
  );

  expect(verified).rejects.toMatchObject({ code: 'auth_blocked', data: { state: 'revoked' } });
  expect(ctx.port.calls).toStrictEqual([]);
});

test('it records the block of a revoke and keeps it pending when impd cannot be reached', async () => {
  await using ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const attemptID = await ctx.binder.createBinding(ctx.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: buildMockAuthBinding({
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      hash: 'h1',
    }),
  });

  await ctx.binder.updateReady(toSessionID('s1'), attemptID);

  const revoked = ctx.binder.revokeBinding(null, toSessionID('s1'));

  expect(revoked).rejects.toMatchObject({
    code: 'auth_revocation_pending',
    data: { pending: ['glm'] },
  });

  expect<Record<string, unknown>>({
    binding: await ctx.store.findAuthBinding(toSessionID('s1')),
    rows: await ctx.store.collectAuthGrants(toSessionID('s1')),
  }).toStrictEqual({
    binding: expect.objectContaining({ state: 'revocation_pending', revokedAt: null }),
    rows: [expect.objectContaining({ secret: 'glm', phase: 'revocation_pending' })],
  });
});

test('it counts a grant a secret rebind already dropped as revoked though the token can no longer revoke it', async () => {
  await using ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const attemptID = await ctx.binder.createBinding(ctx.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: buildMockAuthBinding({
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      hash: 'h1',
    }),
  });

  await ctx.binder.updateReady(toSessionID('s1'), attemptID);

  ctx.port.updateSecret('glm', [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }]);

  await ctx.binder.revokeBinding(ctx.host, toSessionID('s1'));

  const binding = await ctx.store.findAuthBinding(toSessionID('s1'));

  expect(binding).toMatchObject({ state: 'revoked' });
});

test('it keeps a revoke pending when the token cannot revoke a grant impd still holds', async () => {
  await using ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const attemptID = await ctx.binder.createBinding(ctx.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: buildMockAuthBinding({
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      hash: 'h1',
    }),
  });

  await ctx.binder.updateReady(toSessionID('s1'), attemptID);

  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: [],
  });

  const revoked = ctx.binder.revokeBinding(ctx.host, toSessionID('s1'));

  expect(revoked).rejects.toMatchObject({ code: 'auth_revocation_pending' });

  expect<Record<string, unknown>>({
    grants: await ctx.port.readGrants('atc-s1'),
    binding: await ctx.store.findAuthBinding(toSessionID('s1')),
  }).toStrictEqual({
    grants: ['glm'],
    binding: expect.objectContaining({ state: 'revocation_pending' }),
  });
});

test('it rebinds a host to the next revision, granting the new secret and revoking the dropped one', async () => {
  await using ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const attemptID = await ctx.binder.createBinding(ctx.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: buildMockAuthBinding({
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      hash: 'h1',
    }),
  });

  await ctx.binder.updateReady(toSessionID('s1'), attemptID);

  ctx.port.calls.length = 0;

  const revision = await ctx.binder.updateBinding(
    ctx.host,
    toSessionID('s1'),
    buildMockAuthBinding({
      profiles: ['judge'],
      secrets: [
        {
          secret: 'judge',
          kind: 'custom',
          rules: [{ host: 'judge.example', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      hash: 'h2',
    }),
  );

  expect<Record<string, unknown>>({
    revision,
    calls: [...ctx.port.calls],
    grants: await ctx.port.readGrants('atc-s1'),
    binding: await ctx.store.findAuthBinding(toSessionID('s1')),
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
  await using ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const attemptID = await ctx.binder.createBinding(ctx.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: buildMockAuthBinding({
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      hash: 'h1',
    }),
  });

  await ctx.binder.updateReady(toSessionID('s1'), attemptID);

  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge', 'zeta'],
  });

  // Recreated after the token was made, so the token's list no longer
  // covers it and impd refuses its grant.
  ctx.port.createSecret('zeta', 'custom', [
    { host: 'zeta.example', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.removeSecret('zeta');

  ctx.port.createSecret('zeta', 'custom', [
    { host: 'zeta.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const rebound = ctx.binder.updateBinding(
    ctx.host,
    toSessionID('s1'),
    buildMockAuthBinding({
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
      hash: 'h2',
    }),
  );

  expect(rebound).rejects.toMatchObject({ code: 'host_unavailable' });

  const binding = await ctx.store.findAuthBinding(toSessionID('s1'));

  expect<Record<string, unknown>>({
    imps: ctx.port.collectImpNames(),
    grants: await ctx.port.readGrants('atc-s1'),
    binding,
    rebind: binding?.rebind,
  }).toStrictEqual({
    imps: ['atc-s1'],
    grants: ['glm'],
    binding: expect.objectContaining({ state: 'rebind_failed', revision: 1, bindingHash: 'h1' }),
    rebind: expect.objectContaining({ revision: 2, bindingHash: 'h2' }),
  });
});

test('it takes back one attempt without touching the imp or grants of another host', async () => {
  await using ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const first = await ctx.binder.createBinding(ctx.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: buildMockAuthBinding({
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      hash: 'h1',
    }),
  });

  await ctx.binder.createBinding(ctx.host, {
    hostKey: toSessionID('s2'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: buildMockAuthBinding({
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      hash: 'h1',
    }),
  });

  ctx.port.calls.length = 0;

  await ctx.binder.removeAttempt(ctx.host, toSessionID('s1'), first);

  expect<Record<string, unknown>>({
    calls: [...ctx.port.calls],
    imps: ctx.port.collectImpNames(),
    grants: await ctx.port.readGrants('atc-s2'),
    first: await ctx.store.findAuthBinding(toSessionID('s1')),
    second: await ctx.store.findAuthBinding(toSessionID('s2')),
  }).toStrictEqual({
    calls: ['tokens.whoami', 'imps.get atc-s1', 'imps.destroy atc-s1', 'imps.get atc-s1'],
    imps: ['atc-s2'],
    grants: ['glm'],
    first: null,
    second: expect.objectContaining({ hostKey: 's2', state: 'provisioning' }),
  });
});

test('it leaves a host alone when asked to take back an attempt other than the one it holds', async () => {
  await using ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  await ctx.binder.createBinding(ctx.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: buildMockAuthBinding({
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      hash: 'h1',
    }),
  });

  ctx.port.calls.length = 0;

  await ctx.binder.removeAttempt(ctx.host, toSessionID('s1'), 'another-attempt');

  expect<Record<string, unknown>>({
    calls: ctx.port.calls,
    imps: ctx.port.collectImpNames(),
  }).toStrictEqual({
    calls: [],
    imps: ['atc-s1'],
  });
});

test('it forgets a bound host by destroying its imp and dropping the record', async () => {
  await using ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const attemptID = await ctx.binder.createBinding(ctx.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: buildMockAuthBinding({
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      hash: 'h1',
    }),
  });

  await ctx.binder.updateReady(toSessionID('s1'), attemptID);

  ctx.port.calls.length = 0;

  const forgotten = await ctx.binder.forgetBinding(ctx.host, toSessionID('s1'));

  const calls = [...ctx.port.calls];

  const secrets = await ctx.port.readSecrets();

  expect<Record<string, unknown>>({
    forgotten,
    calls,
    imps: ctx.port.collectImpNames(),
    secrets: secrets.map((secret) => secret.name),
    binding: await ctx.store.findAuthBinding(toSessionID('s1')),
  }).toStrictEqual({
    forgotten: true,
    calls: ['tokens.whoami', 'imps.get atc-s1', 'imps.destroy atc-s1', 'imps.get atc-s1'],
    imps: [],
    secrets: ['glm', 'judge'],
    binding: null,
  });
});

test('it refuses to forget a host whose imp was made again and leaves that imp alone', async () => {
  await using ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const attemptID = await ctx.binder.createBinding(ctx.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: buildMockAuthBinding({
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      hash: 'h1',
    }),
  });

  await ctx.binder.updateReady(toSessionID('s1'), attemptID);
  await ctx.port.destroyImp('atc-s1');
  await ctx.port.createImp({ name: 'atc-s1' });

  const forgotten = ctx.binder.forgetBinding(ctx.host, toSessionID('s1'));

  expect(forgotten).rejects.toMatchObject({ code: 'auth_revocation_pending' });

  expect<Record<string, unknown>>({
    imps: ctx.port.collectImpNames(),
    binding: await ctx.store.findAuthBinding(toSessionID('s1')),
  }).toStrictEqual({
    imps: ['atc-s1'],
    binding: expect.objectContaining({ state: 'revocation_pending' }),
  });
});

test('it takes back a provisioning attempt no fleet entry lists as a daemon starts, and leaves a listed host alone', async () => {
  await using ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  for (const hostKey of ['s1', 's2']) {
    await ctx.binder.createBinding(ctx.host, {
      hostKey: toSessionID(hostKey),
      target: 'box',
      targetIdentity: 'imp:test',
      binding: buildMockAuthBinding({
        profiles: ['glm'],
        secrets: [
          {
            secret: 'glm',
            kind: 'custom',
            rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
          },
        ],
        hash: 'h1',
      }),
    });
  }

  const logged: string[] = [];

  await ctx.binder.reconcileBindings(
    (target) => (target === 'box' ? ctx.host : null),
    new Set([toSessionID('s2')]),
    (line) => {
      logged.push(line);
    },
  );

  expect<Record<string, unknown>>({
    logged,
    imps: ctx.port.collectImpNames(),
    first: await ctx.store.findAuthBinding(toSessionID('s1')),
    second: await ctx.store.findAuthBinding(toSessionID('s2')),
  }).toStrictEqual({
    logged: [],
    imps: ['atc-s2'],
    first: null,
    second: expect.objectContaining({ state: 'provisioning' }),
  });
});

test('it fails a rebind a stopped daemon left in flight and revokes only the grants it added', async () => {
  await using ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const attemptID = await ctx.binder.createBinding(ctx.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: buildMockAuthBinding({
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      hash: 'h1',
    }),
  });

  await ctx.binder.updateReady(toSessionID('s1'), attemptID);

  await ctx.store.updateAuthBinding(
    toSessionID('s1'),
    {
      state: 'provisioning',
      rebind: { revision: 2, bindingHash: 'h2', bindingJSON: '{}', attemptID: 'rebind-1' },
    },
    2000,
  );

  await ctx.store.upsertAuthGrant(
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

  await ctx.port.createGrant('atc-s1', 'judge');

  await ctx.binder.reconcileBindings(
    () => ctx.host,
    new Set([toSessionID('s1')]),
    () => {},
  );

  expect<Record<string, unknown>>({
    grants: await ctx.port.readGrants('atc-s1'),
    binding: await ctx.store.findAuthBinding(toSessionID('s1')),
  }).toStrictEqual({
    grants: ['glm'],
    binding: expect.objectContaining({ state: 'rebind_failed', revision: 1 }),
  });
});

test('it rebinds a provisioned host whose spawn listed but never recorded its start', async () => {
  await using ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  await ctx.binder.createBinding(ctx.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: buildMockAuthBinding({
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      hash: 'h1',
    }),
  });

  const revision = await ctx.binder.updateBinding(
    ctx.host,
    toSessionID('s1'),
    buildMockAuthBinding({
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      hash: 'h1',
    }),
  );

  const binding = await ctx.store.findAuthBinding(toSessionID('s1'));

  expect<Record<string, unknown>>({ revision, binding }).toStrictEqual({
    revision: 2,
    binding: expect.objectContaining({ state: 'ready', revision: 2, rebind: null }),
  });
});

test('it refuses to rebind a host whose spawn is still provisioning before it created the imp', async () => {
  await using ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  await ctx.store.createAuthBinding(
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

  const rebound = ctx.binder.updateBinding(
    ctx.host,
    toSessionID('s1'),
    buildMockAuthBinding({
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      hash: 'h1',
    }),
  );

  expect(rebound).rejects.toMatchObject({ code: 'auth_blocked', data: { state: 'provisioning' } });
});

test('it refuses to take back an attempt through a target whose imp prefix changed, and destroys no imp', async () => {
  await using ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const attemptID = await ctx.binder.createBinding(ctx.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: buildMockAuthBinding({
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      hash: 'h1',
    }),
  });

  await ctx.port.createImp({ name: 'atc-new-s1' });

  const renamed = new ImpProvider(ctx.port, { impPrefix: 'atc-new-' }, { atcBinary: null });

  onTestFinished(() => {
    renamed.dispose();
  });

  const removed = ctx.binder.removeAttempt(renamed.brokerAuth, toSessionID('s1'), attemptID);

  expect(removed).rejects.toThrowWithMessage(
    EffectRemainsError,
    /^atc could not take back the runtime auth of host s1 \(/,
  );

  expect<Record<string, unknown>>({
    imps: ctx.port.collectImpNames().toSorted(),
    binding: await ctx.store.findAuthBinding(toSessionID('s1')),
  }).toStrictEqual({
    imps: ['atc-new-s1', 'atc-s1'],
    binding: expect.objectContaining({ state: 'rollback_pending' }),
  });
});

test('it keeps the grants a failed rebind added while impd cannot be reached', async () => {
  await using ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const attemptID = await ctx.binder.createBinding(ctx.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: buildMockAuthBinding({
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      hash: 'h1',
    }),
  });

  await ctx.binder.updateReady(toSessionID('s1'), attemptID);

  await ctx.store.updateAuthBinding(
    toSessionID('s1'),
    {
      state: 'provisioning',
      rebind: { revision: 2, bindingHash: 'h2', bindingJSON: '{}', attemptID: 'rebind-1' },
    },
    2000,
  );

  await ctx.store.upsertAuthGrant(
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

  await ctx.port.createGrant('atc-s1', 'judge');

  await ctx.binder.reconcileBindings(
    () => null,
    new Set([toSessionID('s1')]),
    () => {},
  );

  const grants = await ctx.port.readGrants('atc-s1');

  expect(grants).toStrictEqual(['glm', 'judge']);
});

test('it retries the removal of the grants a failed rebind added on a later start once impd is reachable', async () => {
  await using ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const attemptID = await ctx.binder.createBinding(ctx.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: buildMockAuthBinding({
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      hash: 'h1',
    }),
  });

  await ctx.binder.updateReady(toSessionID('s1'), attemptID);

  await ctx.store.updateAuthBinding(
    toSessionID('s1'),
    {
      state: 'provisioning',
      rebind: { revision: 2, bindingHash: 'h2', bindingJSON: '{}', attemptID: 'rebind-1' },
    },
    2000,
  );

  await ctx.store.upsertAuthGrant(
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

  await ctx.port.createGrant('atc-s1', 'judge');

  await ctx.binder.reconcileBindings(
    () => null,
    new Set([toSessionID('s1')]),
    () => {},
  );

  await ctx.binder.reconcileBindings(
    () => ctx.host,
    new Set([toSessionID('s1')]),
    () => {},
  );

  expect<Record<string, unknown>>({
    grants: await ctx.port.readGrants('atc-s1'),
    binding: await ctx.store.findAuthBinding(toSessionID('s1')),
  }).toStrictEqual({
    grants: ['glm'],
    binding: expect.objectContaining({ state: 'rebind_failed', revision: 1 }),
  });
});

test('it hands a launch over before a revoke that arrives during its admission, which then completes', async () => {
  await using ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const attemptID = await ctx.binder.createBinding(ctx.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: buildMockAuthBinding({
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      hash: 'h1',
    }),
  });

  await ctx.binder.updateReady(toSessionID('s1'), attemptID);

  const order: string[] = [];
  const revoked: Promise<void>[] = [];

  await ctx.binder.withLaunchAdmission(
    toSessionID('s1'),
    { revision: 1, hash: 'h1', attemptID: null },
    'start',
    () => {
      revoked.push(
        (async () => {
          await ctx.binder.revokeBinding(ctx.host, toSessionID('s1'));

          order.push('revoked');
        })(),
      );

      order.push('sent');
    },
  );

  await Promise.all(revoked);

  expect<Record<string, unknown>>({
    order,
    binding: await ctx.store.findAuthBinding(toSessionID('s1')),
  }).toStrictEqual({
    order: ['sent', 'revoked'],
    binding: expect.objectContaining({ state: 'revoked' }),
  });
});

test('it refuses a launch whose admission waits behind a revoke, handing nothing over', async () => {
  await using ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const attemptID = await ctx.binder.createBinding(ctx.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: buildMockAuthBinding({
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      hash: 'h1',
    }),
  });

  await ctx.binder.updateReady(toSessionID('s1'), attemptID);

  const sent: string[] = [];
  const revoked = ctx.binder.revokeBinding(ctx.host, toSessionID('s1'));

  const admitted = ctx.binder.withLaunchAdmission(
    toSessionID('s1'),
    { revision: 1, hash: 'h1', attemptID: null },
    'start',
    () => {
      sent.push('start');
    },
  );

  await Promise.allSettled([admitted, revoked]);

  expect(admitted).rejects.toMatchObject({ code: 'auth_blocked', data: { state: 'revoked' } });
  expect(sent).toStrictEqual([]);
});

test('it refuses a start planned under another binding hash than the ready one', async () => {
  await using ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const attemptID = await ctx.binder.createBinding(ctx.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: buildMockAuthBinding({
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      hash: 'h1',
    }),
  });

  await ctx.binder.updateReady(toSessionID('s1'), attemptID);

  const sent: string[] = [];

  const admitted = ctx.binder.withLaunchAdmission(
    toSessionID('s1'),
    { revision: 1, hash: 'h0', attemptID: null },
    'start',
    () => {
      sent.push('start');
    },
  );

  expect(admitted).rejects.toMatchObject({ code: 'auth_rebind_required' });
  expect(sent).toStrictEqual([]);
});

test('it holds a launch admission while its connection opens and returns it once the request goes out', async () => {
  await using ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const attemptID = await ctx.binder.createBinding(ctx.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: buildMockAuthBinding({
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      hash: 'h1',
    }),
  });

  await ctx.binder.updateReady(toSessionID('s1'), attemptID);
  await ctx.port.createImp({ name: 'imp-x' });

  ctx.port.startUpgradeHold();

  const harness = new ImpHarness(
    ctx.port,
    {
      kind: 'start',
      name: 'imp-x',
      session: 's2',
      argv: ['sleep', '30'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
      require: ['broker'],
    },
    {
      offsets: true,
      reconnectDelaysMs: [],
      isSuspending: () => false,
      onDone: () => {},
      admit: (kind, send) =>
        ctx.binder.withLaunchAdmission(
          toSessionID('s1'),
          { revision: 1, hash: 'h1', attemptID: null },
          kind,
          send,
        ),
    },
  );

  onTestFinished(() => {
    harness.detach();
  });

  await waitFor(() => {
    expect(ctx.port.countHeldUpgrades()).toBe(1);
  });

  const held = ctx.binder.countPendingAdmissions(toSessionID('s1'));

  ctx.port.stopUpgradeHold();

  await Promise.allSettled([harness.waitForStart()]);

  expect(held).toBe(1);
  expect(ctx.binder.countPendingAdmissions(toSessionID('s1'))).toBe(0);

  expect(ctx.port.sessionRequests).toStrictEqual([
    {
      kind: 'start',
      name: 'imp-x',
      session: 's2',
      argv: ['sleep', '30'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
      require: ['broker'],
    },
  ]);
});

test('it returns the launch admission of each connection that fails before it opens', async () => {
  await using ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const attemptID = await ctx.binder.createBinding(ctx.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: buildMockAuthBinding({
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      hash: 'h1',
    }),
  });

  await ctx.binder.updateReady(toSessionID('s1'), attemptID);
  await ctx.port.createImp({ name: 'imp-x' });

  ctx.port.setUpgradeFailures(6);

  const pending: number[] = [];

  for (const session of ['s2', 's3', 's4']) {
    const harness = new ImpHarness(
      ctx.port,
      {
        kind: 'start',
        name: 'imp-x',
        session,
        argv: ['sleep', '30'],
        env: {},
        cwd: ctx.dir,
        cols: 80,
        rows: 24,
        require: ['broker'],
      },
      {
        offsets: true,
        reconnectDelaysMs: [0],
        isSuspending: () => false,
        onDone: () => {},
        admit: (kind, send) =>
          ctx.binder.withLaunchAdmission(
            toSessionID('s1'),
            { revision: 1, hash: 'h1', attemptID: null },
            kind,
            send,
          ),
      },
    );

    onTestFinished(() => {
      harness.detach();
    });

    await Promise.allSettled([harness.waitForStart()]);

    pending.push(ctx.binder.countPendingAdmissions(toSessionID('s1')));
  }

  expect({ pending, requests: ctx.port.sessionRequests }).toStrictEqual({
    pending: [0, 0, 0],
    requests: [],
  });
});

test('it returns the launch admission of a connection whose opening throws before it returns', async () => {
  await using ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const attemptID = await ctx.binder.createBinding(ctx.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: buildMockAuthBinding({
      profiles: ['glm'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      hash: 'h1',
    }),
  });

  await ctx.binder.updateReady(toSessionID('s1'), attemptID);
  await ctx.port.createImp({ name: 'imp-x' });

  ctx.port.setOpenFailures(1);

  const harness = new ImpHarness(
    ctx.port,
    {
      kind: 'start',
      name: 'imp-x',
      session: 's2',
      argv: ['sleep', '30'],
      env: {},
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
      require: ['broker'],
    },
    {
      offsets: true,
      reconnectDelaysMs: [],
      isSuspending: () => false,
      onDone: () => {},
      admit: (kind, send) =>
        ctx.binder.withLaunchAdmission(
          toSessionID('s1'),
          { revision: 1, hash: 'h1', attemptID: null },
          kind,
          send,
        ),
    },
  );

  onTestFinished(() => {
    harness.detach();
  });

  const started = harness.waitForStart();

  expect(started).rejects.toMatchObject({ code: 'internal' });

  expect({
    pending: ctx.binder.countPendingAdmissions(toSessionID('s1')),
    requests: ctx.port.sessionRequests,
  }).toStrictEqual({ pending: 0, requests: [] });
});
