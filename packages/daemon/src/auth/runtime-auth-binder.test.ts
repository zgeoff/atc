import { expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { toSessionID } from '@atc/core';
import { EffectRemainsError } from '@atc/plugin-api';
import type { LaunchTicket } from '@atc/plugin-api';
import { StateStore } from '@atc/store';
import { createMigratedStateDB } from '@atc/store/testing';
import { registerTestCleanup, setupTempDir } from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { buildMockAuthBinding } from '../testing/build-mock-auth-binding';
import { buildStubBinderBroker } from '../testing/build-stub-binder-broker';
import { buildStubCredentialBroker } from '../testing/build-stub-credential-broker';
import { buildStubPregrantedBrokerHost } from '../testing/build-stub-pregranted-broker-host';
import { RuntimeAuthBinder } from './runtime-auth-binder';

// A binder over a real state store, a broker that refuses grants as impd
// does behind the imp provider, which the test prepares as an operator
// prepares impd, and a broker stand-in that enforces no authority for the
// contract's own guarantees.
async function setupTest() {
  const tmp = setupTempDir('atc-auth-binder-');
  const dbPath = join(tmp.dir, 'state.db');

  await createMigratedStateDB(dbPath);

  const store = await StateStore.open(dbPath);

  registerTestCleanup(() => store.stop());

  return {
    store,
    host: buildStubBinderBroker('atc-'),
    broker: buildStubCredentialBroker('atc-'),
    binder: new RuntimeAuthBinder(store),
  };
}

test('it provisions a host through the gate, a new imp and each grant, in that order, and records the imp and its grants', async () => {
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.createSecret('judge', 'custom', [
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

  expect(ctx.host.calls).toStrictEqual([
    'readFeatures',
    'readIdentity',
    'readSecrets',
    'readHost atc-s1',
    'createHost atc-s1',
    'readGrants atc-s1',
    'createGrant atc-s1 glm',
  ]);

  const binding = await ctx.store.findAuthBinding(toSessionID('s1'));
  const grants = await ctx.store.collectAuthGrants(toSessionID('s1'));
  const imp = await ctx.host.readHost('atc-s1');

  invariant(imp);

  expect(binding).toMatchObject({
    impName: 'atc-s1',
    impID: imp.id,
    revision: 1,
    bindingHash: 'h1',
    state: 'provisioning',
    attemptID,
    impCreatedByAttempt: true,
  });

  expect(grants).toMatchObject([
    {
      secret: 'glm',
      revision: 1,
      attemptID,
      preexisting: false,
      phase: 'granted',
    },
  ]);
});

test('it provisions a host with two secrets in four round trips to impd', async () => {
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.holdCalls();

  const created = ctx.binder.createBinding(ctx.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: buildMockAuthBinding({
      profiles: ['glm', 'judge'],
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
      ],
      hash: 'h1',
    }),
  });

  const gateRound = await ctx.host.waitForHeldCalls(4);

  ctx.host.releaseCalls();
  ctx.host.holdCalls();

  const createRound = await ctx.host.waitForHeldCalls(1);

  ctx.host.releaseCalls();
  ctx.host.holdCalls();

  const grantsReadRound = await ctx.host.waitForHeldCalls(1);

  ctx.host.releaseCalls();
  ctx.host.holdCalls();

  const grantRound = await ctx.host.waitForHeldCalls(2);

  ctx.host.releaseCalls();

  await created;

  expect([gateRound, createRound, grantsReadRound, grantRound]).toStrictEqual([
    ['readFeatures', 'readIdentity', 'readSecrets', 'readHost atc-s1'],
    ['createHost atc-s1'],
    ['readGrants atc-s1'],
    ['createGrant atc-s1 glm', 'createGrant atc-s1 judge'],
  ]);
});

test('it refuses an impd without exec requirements and records nothing', async () => {
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.setFeatures({ execRequire: false });

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

  const calls = [...ctx.host.calls];

  const binding = await ctx.store.findAuthBinding(toSessionID('s1'));

  expect(calls).toStrictEqual(['readFeatures', 'readIdentity', 'readSecrets', 'readHost atc-s1']);
  expect(binding).toBeNull();
});

test('it refuses a token that reaches every imp and records nothing', async () => {
  const ctx = await setupTest();

  // The token `host-wide` manages every imp, not only `atc-*` ones.
  ctx.host.setIdentity({
    name: 'host-wide',
    scope: 'manage',
    hosts: null,
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

  const calls = [...ctx.host.calls];

  const binding = await ctx.store.findAuthBinding(toSessionID('s1'));

  expect(calls).toStrictEqual(['readFeatures', 'readIdentity', 'readSecrets', 'readHost atc-s1']);
  expect(binding).toBeNull();
});

test('it refuses a secret whose rules differ from the binding and creates no imp', async () => {
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `judge` for
  // judge.example and `glm` for api.z.ai and elsewhere.example, both custom
  // bearer secrets.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.host.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.createSecret('glm', 'custom', [
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

  const calls = [...ctx.host.calls];

  const binding = await ctx.store.findAuthBinding(toSessionID('s1'));

  expect(calls).toStrictEqual(['readFeatures', 'readIdentity', 'readSecrets', 'readHost atc-s1']);
  expect(binding).toBeNull();
});

test('it refuses an imp that already holds the name and grants nothing to it', async () => {
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  await ctx.host.createHost('s1');

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

  const calls = [...ctx.host.calls];

  const grants = await ctx.host.readGrants('atc-s1');
  const binding = await ctx.store.findAuthBinding(toSessionID('s1'));

  expect(calls).toStrictEqual([
    'createHost atc-s1',
    'readFeatures',
    'readIdentity',
    'readSecrets',
    'readHost atc-s1',
  ]);

  expect(grants).toStrictEqual([]);
  expect(binding).toBeNull();
});

test('it takes back the imp a refused grant left and drops the record', async () => {
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  // A rebind of the secret's rules leaves the token's grantable list behind.
  ctx.host.updateSecret('glm', [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }]);

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

  const imps = ctx.host.collectHostNames();

  const binding = await ctx.store.findAuthBinding(toSessionID('s1'));

  expect(ctx.host.calls).toStrictEqual([
    'readFeatures',
    'readIdentity',
    'readSecrets',
    'readHost atc-s1',
    'createHost atc-s1',
    'readGrants atc-s1',
    'createGrant atc-s1 glm',
    'readIdentity',
    'readHost atc-s1',
    'destroyHost atc-s1',
    'readHost atc-s1',
  ]);

  expect(imps).toStrictEqual([]);
  expect(binding).toBeNull();
});

test('it verifies a bound host without granting anything again', async () => {
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.createSecret('judge', 'custom', [
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

  ctx.host.calls.length = 0;

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

  expect(verified.state).toBe('ready');

  expect(ctx.host.calls).toStrictEqual([
    'readFeatures',
    'readIdentity',
    'readSecrets',
    'readHost atc-s1',
    'readGrants atc-s1',
  ]);
});

test('it verifies a bound host in one round trip to impd', async () => {
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm`, and impd holds `glm` for api.z.ai as a custom
  // bearer secret.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
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

  ctx.host.holdCalls();

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

  const round = await ctx.host.waitForHeldCalls(5);

  ctx.host.releaseCalls();

  await verified;

  expect(round).toStrictEqual([
    'readFeatures',
    'readIdentity',
    'readSecrets',
    'readHost atc-s1',
    'readGrants atc-s1',
  ]);
});

test('it refuses a host whose grant was revoked outside atc and grants it no more', async () => {
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.createSecret('judge', 'custom', [
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
  await ctx.host.removeGrant('atc-s1', 'glm');

  ctx.host.calls.length = 0;

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

  expect(ctx.host.calls).toStrictEqual([
    'readFeatures',
    'readIdentity',
    'readSecrets',
    'readHost atc-s1',
    'readGrants atc-s1',
  ]);
});

test('it refuses a host that holds a grant its binding does not', async () => {
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.createSecret('judge', 'custom', [
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
  await ctx.host.createGrant('atc-s1', 'judge');

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

  const grants = await ctx.host.readGrants('atc-s1');

  expect(grants).toStrictEqual(['glm', 'judge']);
});

test('it refuses a host whose used profiles changed before it reaches impd', async () => {
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.createSecret('judge', 'custom', [
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

  ctx.host.calls.length = 0;

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
  expect(ctx.host.calls).toStrictEqual([]);
});

test('it refuses an imp made again under the recorded name', async () => {
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.createSecret('judge', 'custom', [
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
  await ctx.host.destroyHost('s1');
  await ctx.host.createHost('s1');
  await ctx.host.createGrant('atc-s1', 'glm');

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
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.createSecret('judge', 'custom', [
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
  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'x-api-key', scheme: 'bearer' },
  ]);

  ctx.host.calls.length = 0;

  await ctx.binder.revokeBinding(ctx.host, toSessionID('s1'));

  const calls = [...ctx.host.calls];

  const grants = await ctx.host.readGrants('atc-s1');
  const binding = await ctx.store.findAuthBinding(toSessionID('s1'));
  const rows = await ctx.store.collectAuthGrants(toSessionID('s1'));

  expect(calls).toStrictEqual(['readIdentity', 'readHost atc-s1', 'removeGrant atc-s1 glm']);
  expect(grants).toStrictEqual([]);
  expect(binding).toMatchObject({ state: 'revoked', revokedAt: expect.toBeNumber() });
  expect(rows).toMatchObject([{ secret: 'glm', phase: 'revoked' }]);
});

test('it blocks every launch on a host once its grants are revoked', async () => {
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.createSecret('judge', 'custom', [
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

  ctx.host.calls.length = 0;

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
  expect(ctx.host.calls).toStrictEqual([]);
});

test('it records the block of a revoke and keeps it pending when impd cannot be reached', async () => {
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.createSecret('judge', 'custom', [
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

  const binding = await ctx.store.findAuthBinding(toSessionID('s1'));
  const rows = await ctx.store.collectAuthGrants(toSessionID('s1'));

  expect(binding).toMatchObject({ state: 'revocation_pending', revokedAt: null });
  expect(rows).toMatchObject([{ secret: 'glm', phase: 'revocation_pending' }]);
});

test('it counts a grant a secret rebind already dropped as revoked though the token can no longer revoke it', async () => {
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.createSecret('judge', 'custom', [
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

  ctx.host.updateSecret('glm', [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }]);

  await ctx.binder.revokeBinding(ctx.host, toSessionID('s1'));

  const binding = await ctx.store.findAuthBinding(toSessionID('s1'));

  expect(binding).toMatchObject({ state: 'revoked' });
});

test('it keeps a revoke pending when the token cannot revoke a grant impd still holds', async () => {
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.createSecret('judge', 'custom', [
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

  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: [],
  });

  const revoked = ctx.binder.revokeBinding(ctx.host, toSessionID('s1'));

  expect(revoked).rejects.toMatchObject({ code: 'auth_revocation_pending' });

  const grants = await ctx.host.readGrants('atc-s1');
  const binding = await ctx.store.findAuthBinding(toSessionID('s1'));

  expect(grants).toStrictEqual(['glm']);
  expect(binding).toMatchObject({ state: 'revocation_pending' });
});

test('it rebinds a host to the next revision, granting the new secret and revoking the dropped one', async () => {
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.createSecret('judge', 'custom', [
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

  ctx.host.calls.length = 0;

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

  const calls = [...ctx.host.calls];

  const grants = await ctx.host.readGrants('atc-s1');
  const binding = await ctx.store.findAuthBinding(toSessionID('s1'));

  expect(revision).toBe(2);

  expect(calls).toStrictEqual([
    'readFeatures',
    'readIdentity',
    'readSecrets',
    'readIdentity',
    'readHost atc-s1',
    'readGrants atc-s1',
    'createGrant atc-s1 judge',
    'removeGrant atc-s1 glm',
  ]);

  expect(grants).toStrictEqual(['judge']);

  expect(binding).toMatchObject({
    state: 'ready',
    revision: 2,
    bindingHash: 'h2',
    rebind: null,
  });
});

test('it removes only the grants a failed rebind added and keeps the imp at the old revision', async () => {
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.createSecret('judge', 'custom', [
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

  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge', 'zeta'],
  });

  // Recreated after the token was made, so the token's list no longer
  // covers it and impd refuses its grant.
  ctx.host.createSecret('zeta', 'custom', [
    { host: 'zeta.example', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.removeSecret('zeta');

  ctx.host.createSecret('zeta', 'custom', [
    { host: 'zeta.example', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.calls.length = 0;

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

  const calls = [...ctx.host.calls];

  const binding = await ctx.store.findAuthBinding(toSessionID('s1'));

  const imps = ctx.host.collectHostNames();

  const grants = await ctx.host.readGrants('atc-s1');

  expect(calls).toStrictEqual([
    'readFeatures',
    'readIdentity',
    'readSecrets',
    'readIdentity',
    'readHost atc-s1',
    'readGrants atc-s1',
    'createGrant atc-s1 judge',
    'createGrant atc-s1 zeta',
    'removeGrant atc-s1 judge',
    'removeGrant atc-s1 zeta',
    'readGrants atc-s1',
  ]);

  expect(imps).toStrictEqual(['atc-s1']);
  expect(grants).toStrictEqual(['glm']);
  expect(binding).toMatchObject({ state: 'rebind_failed', revision: 1, bindingHash: 'h1' });
  expect(binding?.rebind).toMatchObject({ revision: 2, bindingHash: 'h2' });
});

test('it takes back one attempt without touching the imp or grants of another host', async () => {
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.createSecret('judge', 'custom', [
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

  ctx.host.calls.length = 0;

  await ctx.binder.removeAttempt(ctx.host, toSessionID('s1'), first);

  const calls = [...ctx.host.calls];
  const imps = ctx.host.collectHostNames();

  const grants = await ctx.host.readGrants('atc-s2');
  const firstBinding = await ctx.store.findAuthBinding(toSessionID('s1'));
  const secondBinding = await ctx.store.findAuthBinding(toSessionID('s2'));

  expect(calls).toStrictEqual([
    'readIdentity',
    'readHost atc-s1',
    'destroyHost atc-s1',
    'readHost atc-s1',
  ]);

  expect(imps).toStrictEqual(['atc-s2']);
  expect(grants).toStrictEqual(['glm']);
  expect(firstBinding).toBeNull();
  expect(secondBinding).toMatchObject({ hostKey: 's2', state: 'provisioning' });
});

test('it leaves a host alone when asked to take back an attempt other than the one it holds', async () => {
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.createSecret('judge', 'custom', [
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

  ctx.host.calls.length = 0;

  await ctx.binder.removeAttempt(ctx.host, toSessionID('s1'), 'another-attempt');

  expect(ctx.host.calls).toStrictEqual([]);
  expect(ctx.host.collectHostNames()).toStrictEqual(['atc-s1']);
});

test('it forgets a bound host by destroying its imp and dropping the record', async () => {
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.createSecret('judge', 'custom', [
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

  ctx.host.calls.length = 0;

  const forgotten = await ctx.binder.forgetBinding(ctx.host, toSessionID('s1'));

  const calls = [...ctx.host.calls];

  const secrets = await ctx.host.readSecrets();

  const imps = ctx.host.collectHostNames();
  const secretNames = secrets.map((secret) => secret.name);

  const binding = await ctx.store.findAuthBinding(toSessionID('s1'));

  expect(forgotten).toBeTrue();

  expect(calls).toStrictEqual([
    'readIdentity',
    'readHost atc-s1',
    'destroyHost atc-s1',
    'readHost atc-s1',
  ]);

  expect(imps).toStrictEqual([]);
  expect(secretNames).toStrictEqual(['glm', 'judge']);
  expect(binding).toBeNull();
});

test('it refuses to forget a host whose imp was made again and leaves that imp alone', async () => {
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.createSecret('judge', 'custom', [
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
  await ctx.host.destroyHost('s1');
  await ctx.host.createHost('s1');

  const forgotten = ctx.binder.forgetBinding(ctx.host, toSessionID('s1'));

  expect(forgotten).rejects.toMatchObject({ code: 'auth_revocation_pending' });

  const imps = ctx.host.collectHostNames();

  const binding = await ctx.store.findAuthBinding(toSessionID('s1'));

  expect(imps).toStrictEqual(['atc-s1']);
  expect(binding).toMatchObject({ state: 'revocation_pending' });
});

test('it takes back a provisioning attempt no fleet entry lists as a daemon starts, and leaves a listed host alone', async () => {
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.createSecret('judge', 'custom', [
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

  const imps = ctx.host.collectHostNames();

  const firstBinding = await ctx.store.findAuthBinding(toSessionID('s1'));
  const secondBinding = await ctx.store.findAuthBinding(toSessionID('s2'));

  expect(logged).toStrictEqual([]);
  expect(imps).toStrictEqual(['atc-s2']);
  expect(firstBinding).toBeNull();
  expect(secondBinding).toMatchObject({ state: 'provisioning' });
});

test('it fails a rebind a stopped daemon left in flight and revokes only the grants it added', async () => {
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.createSecret('judge', 'custom', [
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

  await ctx.host.createGrant('atc-s1', 'judge');

  await ctx.binder.reconcileBindings(
    () => ctx.host,
    new Set([toSessionID('s1')]),
    () => {},
  );

  const grants = await ctx.host.readGrants('atc-s1');
  const binding = await ctx.store.findAuthBinding(toSessionID('s1'));

  expect(grants).toStrictEqual(['glm']);
  expect(binding).toMatchObject({ state: 'rebind_failed', revision: 1 });
});

test('it rebinds a provisioned host whose spawn listed but never recorded its start', async () => {
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.createSecret('judge', 'custom', [
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

  expect(revision).toBe(2);
  expect(binding).toMatchObject({ state: 'ready', revision: 2, rebind: null });
});

test('it refuses to rebind a host whose spawn is still provisioning before it created the imp', async () => {
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.createSecret('judge', 'custom', [
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
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.createSecret('judge', 'custom', [
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

  const renamed = ctx.host.buildRenamedBroker('atc-new-');

  await renamed.createHost('s1');

  const removed = ctx.binder.removeAttempt(renamed, toSessionID('s1'), attemptID);

  expect(removed).rejects.toThrowWithMessage(
    EffectRemainsError,
    /^atc could not take back the runtime auth of host s1 \(/u,
  );

  const imps = ctx.host.collectHostNames().toSorted();

  const binding = await ctx.store.findAuthBinding(toSessionID('s1'));

  expect(imps).toStrictEqual(['atc-new-s1', 'atc-s1']);
  expect(binding).toMatchObject({ state: 'rollback_pending' });
});

test('it keeps the grants a failed rebind added while impd cannot be reached', async () => {
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.createSecret('judge', 'custom', [
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

  await ctx.host.createGrant('atc-s1', 'judge');

  await ctx.binder.reconcileBindings(
    () => null,
    new Set([toSessionID('s1')]),
    () => {},
  );

  const grants = await ctx.host.readGrants('atc-s1');

  expect(grants).toStrictEqual(['glm', 'judge']);
});

test('it retries the removal of the grants a failed rebind added on a later start once impd is reachable', async () => {
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.createSecret('judge', 'custom', [
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

  await ctx.host.createGrant('atc-s1', 'judge');

  await ctx.binder.reconcileBindings(
    () => null,
    new Set([toSessionID('s1')]),
    () => {},
  );

  const grantsWhileUnreachable = await ctx.host.readGrants('atc-s1');

  await ctx.binder.reconcileBindings(
    () => ctx.host,
    new Set([toSessionID('s1')]),
    () => {},
  );

  const grants = await ctx.host.readGrants('atc-s1');
  const binding = await ctx.store.findAuthBinding(toSessionID('s1'));

  expect(grantsWhileUnreachable).toStrictEqual(['glm', 'judge']);
  expect(grants).toStrictEqual(['glm']);
  expect(binding).toMatchObject({ state: 'rebind_failed', revision: 1 });
});

test('it hands a launch over before a revoke that arrives during its admission, which then completes', async () => {
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.createSecret('judge', 'custom', [
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

  const binding = await ctx.store.findAuthBinding(toSessionID('s1'));

  expect(order).toStrictEqual(['sent', 'revoked']);
  expect(binding).toMatchObject({ state: 'revoked' });
});

test('it refuses a launch whose admission waits behind a revoke, handing nothing over', async () => {
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.createSecret('judge', 'custom', [
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
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.createSecret('judge', 'custom', [
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

test('it holds a launch admission until its ticket is checked and lets the request go at the check', async () => {
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.createSecret('judge', 'custom', [
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

  // The harness keeps the ticket while its connection to impd opens.
  const tickets: LaunchTicket[] = [];

  await ctx.binder.withLaunchAdmission(
    toSessionID('s1'),
    { revision: 1, hash: 'h1', attemptID: null },
    'start',
    (ticket) => {
      tickets.push(ticket);
    },
  );

  const [ticket] = tickets;

  invariant(ticket);

  const held = ctx.binder.countPendingAdmissions(toSessionID('s1'));
  const refusal = ticket.check();

  expect(held).toBe(1);
  expect(refusal).toBeNull();
  expect(ctx.binder.countPendingAdmissions(toSessionID('s1'))).toBe(0);
});

test('it returns the launch admission of each ticket released unchecked', async () => {
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.createSecret('judge', 'custom', [
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

  // Three connections, each of which ends before it opens and releases
  // its ticket unchecked.
  const tickets: LaunchTicket[] = [];

  await Promise.all(
    (['start', 'attach', 'attach'] as const).map((kind) =>
      ctx.binder.withLaunchAdmission(
        toSessionID('s1'),
        { revision: 1, hash: 'h1', attemptID: null },
        kind,
        (ticket) => {
          tickets.push(ticket);
        },
      ),
    ),
  );

  const held = ctx.binder.countPendingAdmissions(toSessionID('s1'));

  for (const ticket of tickets) {
    ticket.release();
  }

  expect(held).toBe(3);
  expect(ctx.binder.countPendingAdmissions(toSessionID('s1'))).toBe(0);
});

test('it refuses to verify a host with no binding as blocked', async () => {
  const ctx = await setupTest();

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
    code: 'auth_blocked',
    data: { host: 's1', state: null },
  });
});

test('it refuses a launch on a host with no binding as blocked, handing nothing over', async () => {
  const ctx = await setupTest();

  const send = mock<(ticket: LaunchTicket) => void>();

  const admitted = ctx.binder.withLaunchAdmission(
    toSessionID('s1'),
    { revision: 1, hash: 'h1', attemptID: null },
    'start',
    send,
  );

  expect(admitted).rejects.toMatchObject({
    code: 'auth_blocked',
    data: { host: 's1', state: null },
  });

  expect(send).not.toHaveBeenCalled();
});

test('it refuses to rebind a host with no binding', async () => {
  const ctx = await setupTest();

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

  expect(rebound).rejects.toMatchObject({
    code: 'unsupported_operation',
    data: { host: 's1', problem: 'no_auth_binding' },
  });
});

test('it refuses to rebind a host revoked before its spawn recorded the imp', async () => {
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm`, and impd holds `glm` for api.z.ai, a custom
  // bearer secret.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
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

  await ctx.binder.revokeBinding(ctx.host, toSessionID('s1'));

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

  expect(rebound).rejects.toMatchObject({
    code: 'auth_runtime_mismatch',
    data: { host: 's1', imp: 'atc-s1', recordedID: null, actualID: null },
  });
});

test('it refuses a new imp that already holds a grant, grants it nothing and takes it back', async () => {
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const created = ctx.binder.createBinding(buildStubPregrantedBrokerHost(ctx.host, 'judge'), {
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
    code: 'auth_grants_mismatch',
    data: { host: 's1', extra: ['judge'] },
  });

  const calls = [...ctx.host.calls];

  // The stand-in's own grant of judge is the only one; the binder never
  // asks for glm.
  expect(calls).toStrictEqual([
    'readFeatures',
    'readIdentity',
    'readSecrets',
    'readHost atc-s1',
    'createHost atc-s1',
    'createGrant atc-s1 judge',
    'readGrants atc-s1',
    'readIdentity',
    'readHost atc-s1',
    'destroyHost atc-s1',
    'readHost atc-s1',
  ]);
});

test('it fails a rebind that cannot revoke a secret the new binding drops as revocation pending', async () => {
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.createSecret('judge', 'custom', [
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

  ctx.host.setGrantRemovalFailure('INTERNAL');

  const rebound = ctx.binder.updateBinding(
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

  expect(rebound).rejects.toMatchObject({
    code: 'auth_revocation_pending',
    data: { host: 's1', pending: ['glm'] },
  });

  const binding = await ctx.store.findAuthBinding(toSessionID('s1'));

  expect(binding).toMatchObject({ state: 'rebind_failed', revision: 1, bindingHash: 'h1' });
});

test('it revokes a host whose grants an earlier revoke already removed, as revoked again', async () => {
  const ctx = await setupTest();

  ctx.broker.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.broker.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  const attemptID = await ctx.binder.createBinding(ctx.broker, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'broker:test',
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
  await ctx.binder.revokeBinding(ctx.broker, toSessionID('s1'));

  ctx.broker.calls.length = 0;

  await ctx.binder.revokeBinding(ctx.broker, toSessionID('s1'));

  const binding = await ctx.store.findAuthBinding(toSessionID('s1'));
  const rows = await ctx.store.collectAuthGrants(toSessionID('s1'));

  expect(ctx.broker.calls).toStrictEqual([
    'readIdentity',
    'readHost atc-s1',
    'removeGrant atc-s1 glm',
  ]);

  expect(binding).toMatchObject({ state: 'revoked' });
  expect(rows).toMatchObject([{ secret: 'glm', phase: 'revoked' }]);
});

test('it forgets a bound host by destroying it through the broker and dropping the record', async () => {
  const ctx = await setupTest();

  ctx.broker.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.broker.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  const attemptID = await ctx.binder.createBinding(ctx.broker, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'broker:test',
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

  ctx.broker.calls.length = 0;

  const forgotten = await ctx.binder.forgetBinding(ctx.broker, toSessionID('s1'));

  const calls = [...ctx.broker.calls];

  const host = await ctx.broker.readHost('atc-s1');
  const binding = await ctx.store.findAuthBinding(toSessionID('s1'));

  expect(forgotten).toBeTrue();

  expect(calls).toStrictEqual([
    'readIdentity',
    'readHost atc-s1',
    'destroyHost atc-s1',
    'readHost atc-s1',
  ]);

  expect(host).toBeNull();
  expect(binding).toBeNull();
});

test('it forgets a bound host that the broker no longer holds as done, destroying nothing', async () => {
  const ctx = await setupTest();

  ctx.broker.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.broker.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  const attemptID = await ctx.binder.createBinding(ctx.broker, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'broker:test',
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
  await ctx.broker.destroyHost('s1');

  ctx.broker.calls.length = 0;

  const forgotten = await ctx.binder.forgetBinding(ctx.broker, toSessionID('s1'));
  const binding = await ctx.store.findAuthBinding(toSessionID('s1'));

  expect(forgotten).toBeTrue();
  expect(ctx.broker.calls).toStrictEqual(['readIdentity', 'readHost atc-s1', 'readHost atc-s1']);
  expect(binding).toBeNull();
});

test('it refuses to forget a host the broker made again under the recorded name and leaves it alone', async () => {
  const ctx = await setupTest();

  ctx.broker.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.broker.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  const attemptID = await ctx.binder.createBinding(ctx.broker, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'broker:test',
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
  await ctx.broker.destroyHost('s1');

  const remade = await ctx.broker.createHost('s1');

  const forgotten = ctx.binder.forgetBinding(ctx.broker, toSessionID('s1'));

  expect(forgotten).rejects.toMatchObject({ code: 'auth_revocation_pending' });

  const host = await ctx.broker.readHost('atc-s1');
  const binding = await ctx.store.findAuthBinding(toSessionID('s1'));

  expect(host).toStrictEqual(remade);
  expect(binding).toMatchObject({ state: 'revocation_pending' });
});

test('it rebinds a changed selection at a verify given a rebind, granting the added secret at the next revision', async () => {
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.createSecret('judge', 'custom', [
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

  const verified = await ctx.binder.verifyBinding(
    ctx.host,
    toSessionID('s1'),
    buildMockAuthBinding({
      profiles: ['glm', 'judge'],
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
      ],
      hash: 'h2',
    }),
    { log: mock<(line: string) => void>() },
  );

  const grants = await ctx.host.readGrants('atc-s1');

  expect(verified).toMatchObject({ state: 'ready', revision: 2, bindingHash: 'h2', rebind: null });
  expect(grants).toIncludeSameMembers(['glm', 'judge']);
});

test('it logs one line for each rebind at a verify with the host, the revisions, and the profiles it adds and drops', async () => {
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.createSecret('judge', 'custom', [
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

  const log = mock<(line: string) => void>();

  await ctx.binder.verifyBinding(
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
    { log },
  );

  expect(log).toHaveBeenCalledExactlyOnceWith(
    'atc: rebound the runtime auth of host s1 from revision 1 to revision 2 (added profiles: judge; removed profiles: glm)',
  );
});

test('it revokes the grant of a dropped profile at a verify given a rebind', async () => {
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const attemptID = await ctx.binder.createBinding(ctx.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: buildMockAuthBinding({
      profiles: ['glm', 'judge'],
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
      ],
      hash: 'h1',
    }),
  });

  await ctx.binder.updateReady(toSessionID('s1'), attemptID);

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
      hash: 'h2',
    }),
    { log: mock<(line: string) => void>() },
  );

  const grants = await ctx.host.readGrants('atc-s1');

  expect(verified).toMatchObject({ state: 'ready', revision: 2, bindingHash: 'h2' });
  expect(grants).toStrictEqual(['glm']);
});

test('it refuses a changed selection at a verify given a rebind when the imp lost a grant both bindings keep, granting nothing', async () => {
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.createSecret('judge', 'custom', [
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
  await ctx.host.removeGrant('atc-s1', 'glm');

  const verified = ctx.binder.verifyBinding(
    ctx.host,
    toSessionID('s1'),
    buildMockAuthBinding({
      profiles: ['glm', 'judge'],
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
      ],
      hash: 'h2',
    }),
    { log: mock<(line: string) => void>() },
  );

  expect(verified).rejects.toMatchObject({ code: 'auth_grant_missing' });

  const grants = await ctx.host.readGrants('atc-s1');
  const binding = await ctx.store.findAuthBinding(toSessionID('s1'));

  expect(grants).toStrictEqual([]);
  expect(binding).toMatchObject({ state: 'ready', revision: 1, bindingHash: 'h1' });
});

test('it refuses a changed selection at a verify given a rebind when the imp was made again under the recorded name', async () => {
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.createSecret('judge', 'custom', [
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
  await ctx.host.destroyHost('s1');
  await ctx.host.createHost('s1');
  await ctx.host.createGrant('atc-s1', 'glm');

  const verified = ctx.binder.verifyBinding(
    ctx.host,
    toSessionID('s1'),
    buildMockAuthBinding({
      profiles: ['glm', 'judge'],
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
      ],
      hash: 'h2',
    }),
    { log: mock<(line: string) => void>() },
  );

  expect(verified).rejects.toMatchObject({ code: 'auth_runtime_mismatch' });

  const grants = await ctx.host.readGrants('atc-s1');

  expect(grants).toStrictEqual(['glm']);
});

test('it leaves a rebind that fails at a verify blocked as a failed rebind at the old revision', async () => {
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const attemptID = await ctx.binder.createBinding(ctx.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: buildMockAuthBinding({
      profiles: ['glm', 'judge'],
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
      ],
      hash: 'h1',
    }),
  });

  await ctx.binder.updateReady(toSessionID('s1'), attemptID);

  ctx.host.setGrantRemovalFailure('INTERNAL');

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
      hash: 'h2',
    }),
    { log: mock<(line: string) => void>() },
  );

  expect(verified).rejects.toMatchObject({ code: 'auth_revocation_pending' });

  const binding = await ctx.store.findAuthBinding(toSessionID('s1'));

  expect(binding).toMatchObject({ state: 'rebind_failed', revision: 1, bindingHash: 'h1' });
});

test('it retries a failed rebind at the next verify given a rebind and moves the binding to the next revision', async () => {
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const attemptID = await ctx.binder.createBinding(ctx.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: buildMockAuthBinding({
      profiles: ['glm', 'judge'],
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
      ],
      hash: 'h1',
    }),
  });

  await ctx.binder.updateReady(toSessionID('s1'), attemptID);

  ctx.host.setGrantRemovalFailure('INTERNAL');

  const failed = ctx.binder.verifyBinding(
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
      hash: 'h2',
    }),
    { log: mock<(line: string) => void>() },
  );

  await expect(failed).toReject();

  ctx.host.setGrantRemovalFailure(null);

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
      hash: 'h2',
    }),
    { log: mock<(line: string) => void>() },
  );

  const grants = await ctx.host.readGrants('atc-s1');

  expect(verified).toMatchObject({ state: 'ready', revision: 2, bindingHash: 'h2', rebind: null });
  expect(grants).toStrictEqual(['glm']);
});

test('it retries a failed rebind at the next verify given a rebind after taking back a grant whose removal failed', async () => {
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm`, `judge` and `zeta`, and impd holds each as a
  // custom bearer secret for its own host.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge', 'zeta'],
  });

  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.createSecret('zeta', 'custom', [
    { host: 'zeta.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const attemptID = await ctx.binder.createBinding(ctx.host, {
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:test',
    binding: buildMockAuthBinding({
      profiles: ['glm', 'judge'],
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
      ],
      hash: 'h1',
    }),
  });

  await ctx.binder.updateReady(toSessionID('s1'), attemptID);

  // impd removes no grant, so the rebind fails on the dropped judge and
  // leaves the zeta grant it added behind.
  ctx.host.setGrantRemovalFailure('INTERNAL');

  const failed = ctx.binder.verifyBinding(
    ctx.host,
    toSessionID('s1'),
    buildMockAuthBinding({
      profiles: ['glm', 'zeta'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
        {
          secret: 'zeta',
          kind: 'custom',
          rules: [{ host: 'zeta.example', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      hash: 'h2',
    }),
    { log: mock<(line: string) => void>() },
  );

  await expect(failed).toReject();

  const left = await ctx.host.readGrants('atc-s1');

  ctx.host.setGrantRemovalFailure(null);

  const verified = await ctx.binder.verifyBinding(
    ctx.host,
    toSessionID('s1'),
    buildMockAuthBinding({
      profiles: ['glm', 'zeta'],
      secrets: [
        {
          secret: 'glm',
          kind: 'custom',
          rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        },
        {
          secret: 'zeta',
          kind: 'custom',
          rules: [{ host: 'zeta.example', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      hash: 'h2',
    }),
    { log: mock<(line: string) => void>() },
  );

  const grants = await ctx.host.readGrants('atc-s1');

  expect(left).toIncludeSameMembers(['glm', 'judge', 'zeta']);
  expect(verified).toMatchObject({ state: 'ready', revision: 2, bindingHash: 'h2' });
  expect(grants).toIncludeSameMembers(['glm', 'zeta']);
});

test('it keeps the pending admission of another harness on the host through a rebind at a verify', async () => {
  const ctx = await setupTest();

  // impd as an operator prepared it: the token `atc-runtime` manages `atc-*`
  // imps and may grant `glm` and `judge`, and impd holds `glm` for api.z.ai
  // and `judge` for judge.example, both custom bearer secrets.
  ctx.host.setIdentity({
    name: 'atc-runtime',
    scope: 'manage',
    hosts: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.host.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.host.createSecret('judge', 'custom', [
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

  // A sibling's reconnect, admitted while its connection to impd opens.
  const tickets: LaunchTicket[] = [];

  await ctx.binder.withLaunchAdmission(
    toSessionID('s1'),
    { revision: 1, hash: 'h1', attemptID: null },
    'attach',
    (ticket) => {
      tickets.push(ticket);
    },
  );

  await ctx.binder.verifyBinding(
    ctx.host,
    toSessionID('s1'),
    buildMockAuthBinding({
      profiles: ['glm', 'judge'],
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
      ],
      hash: 'h2',
    }),
    { log: mock<(line: string) => void>() },
  );

  const [ticket] = tickets;

  invariant(ticket);

  expect(ticket.check()).toBeNull();
});
