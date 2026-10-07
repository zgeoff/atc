import { expect, test } from 'bun:test';
import { buildMockAuthProfile } from '../test-utils/build-mock-auth-profile';
import { buildAuthBinding } from './build-auth-binding';

test('it plans a binding of the resolved secrets, the placeholders and the base URL', () => {
  const planned = buildAuthBinding(
    {
      id: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
      },
    },
    new Map([
      [
        'glm',
        {
          name: 'glm',
          secret: 'glm',
          kind: 'custom',
          host: 'api.z.ai',
          header: 'authorization',
          scheme: 'bearer',
          env: {},
          dependencies: [],
        },
      ],
    ]),
  );

  if (!('binding' in planned)) {
    throw new Error('expected the selection to resolve');
  }

  expect(planned.binding.hash).toMatchInlineSnapshot(
    `"a3d73e2050ff42dc3cf60f6912e59cd2dc412a5228bf466d460a06dda34817c5"`,
  );

  expect(planned).toStrictEqual({
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
      placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
      profileEnv: {},
      hash: planned.binding.hash,
    },
  });
});

test('it keeps the hash when a profile the binding does not use is edited or added', () => {
  const glm = buildMockAuthProfile({ name: 'glm', host: 'api.z.ai' });

  const before = buildAuthBinding(
    {
      id: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: { profiles: ['glm'], placeholderEnv: {} },
    },
    new Map([
      ['glm', glm],
      ['unused', buildMockAuthProfile({ name: 'unused', host: 'other.example.com' })],
    ]),
  );

  const after = buildAuthBinding(
    {
      id: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: { profiles: ['glm'], placeholderEnv: {} },
    },
    new Map([
      ['glm', glm],
      ['unused', buildMockAuthProfile({ name: 'unused', host: 'changed.example.com' })],
      ['added', buildMockAuthProfile({ name: 'added' })],
    ]),
  );

  if (!('binding' in before) || !('binding' in after)) {
    throw new Error('expected both selections to resolve');
  }

  expect(after.binding.hash).toBe(before.binding.hash);
});

test.each([
  ['header', { header: 'x-api-key' }],
  ['host', { host: 'judge2.example.com' }],
  ['secret', { secret: 'judge2' }],
])('it changes the hash when a used dependency profile changes its %s', (_field, change) => {
  const glm = buildMockAuthProfile({ name: 'glm', host: 'api.z.ai', dependencies: ['judge'] });

  const judge = buildMockAuthProfile({
    name: 'judge',
    secret: 'judge',
    host: 'judge.example.com',
    header: 'authorization',
  });

  const before = buildAuthBinding(
    {
      id: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: { profiles: ['glm'], placeholderEnv: {} },
    },
    new Map([
      ['glm', glm],
      ['judge', judge],
    ]),
  );

  const after = buildAuthBinding(
    {
      id: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: { profiles: ['glm'], placeholderEnv: {} },
    },
    new Map([
      ['glm', glm],
      ['judge', { ...judge, ...change }],
    ]),
  );

  if (!('binding' in before) || !('binding' in after)) {
    throw new Error('expected both selections to resolve');
  }

  expect(after.binding.hash).not.toBe(before.binding.hash);
});

test('it keeps the hash when the selection lists the same profiles in another order', () => {
  const profiles = new Map([
    ['glm', buildMockAuthProfile({ name: 'glm', host: 'api.z.ai' })],
    ['judge', buildMockAuthProfile({ name: 'judge', host: 'judge.example.com' })],
  ]);

  const before = buildAuthBinding(
    {
      id: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: { profiles: ['glm', 'judge'], placeholderEnv: {} },
    },
    profiles,
  );

  const after = buildAuthBinding(
    {
      id: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: { profiles: ['judge', 'glm'], placeholderEnv: {} },
    },
    profiles,
  );

  if (!('binding' in before) || !('binding' in after)) {
    throw new Error('expected both selections to resolve');
  }

  expect(after.binding.hash).toBe(before.binding.hash);
});

test('it refuses to plan a binding whose profiles collide on one host', () => {
  expect(
    buildAuthBinding(
      {
        id: 'glm',
        baseURL: 'https://api.z.ai/api/anthropic',
        auth: { profiles: ['glm', 'judge'], placeholderEnv: {} },
      },
      new Map([
        [
          'glm',
          {
            name: 'glm',
            secret: 'glm',
            kind: 'custom',
            host: 'api.z.ai',
            header: 'authorization',
            scheme: 'bearer',
            env: {},
            dependencies: [],
          },
        ],
        [
          'judge',
          {
            name: 'judge',
            secret: 'judge',
            kind: 'custom',
            host: 'api.z.ai',
            header: 'authorization',
            scheme: 'bearer',
            env: {},
            dependencies: [],
          },
        ],
      ]),
    ),
  ).toStrictEqual({
    problem: {
      code: 'auth_collision',
      message: 'profiles glm and judge both send a credential to api.z.ai',
    },
  });
});

test('it hashes the secrets alone when the profiles set no variables', () => {
  const planned = buildAuthBinding(
    {
      id: 'glm',
      baseURL: 'https://op-connect.geoff.cloud/x',
      auth: { profiles: ['op'], placeholderEnv: {} },
    },
    new Map([
      [
        'op',
        {
          name: 'op',
          secret: 'op-connect',
          kind: 'custom',
          host: 'op-connect.geoff.cloud',
          header: 'authorization',
          scheme: 'bearer',
          env: {},
          dependencies: [],
        },
      ],
    ]),
  );

  if (!('binding' in planned)) {
    throw new Error('expected the selection to resolve');
  }

  expect(planned.binding.hash).toMatchInlineSnapshot(
    `"ea1419dcafb7cf04a0a5b311faa3d32d7ed336ece08f75ba2cdc627b0d27bf4c"`,
  );

  expect(planned).toStrictEqual({
    binding: {
      agent: 'glm',
      baseURL: 'https://op-connect.geoff.cloud/x',
      profiles: ['op'],
      secrets: [
        {
          secret: 'op-connect',
          kind: 'custom',
          rules: [{ host: 'op-connect.geoff.cloud', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      placeholderEnv: {},
      profileEnv: {},
      hash: planned.binding.hash,
    },
  });
});

test.each([
  [{}, { OP_CONNECT_TOKEN: 'imp-broker-placeholder' }],
  [{}, { OP_CONNECT_HOST: 'https://op-connect.geoff.cloud' }],
  [
    { OP_CONNECT_TOKEN: 'imp-broker-placeholder' },
    { OP_CONNECT_HOST: 'https://op-connect.geoff.cloud' },
  ],
  [{ OP_CONNECT_TOKEN: 'imp-broker-placeholder' }, { OP_CONNECT_TOKEN: 'another-placeholder' }],
])('it moves the hash when the profile variables change from %o to %o', (before, after) => {
  const op = buildMockAuthProfile({ name: 'op' });

  const first = buildAuthBinding(
    {
      id: 'glm',
      baseURL: 'https://op-connect.geoff.cloud/x',
      auth: { profiles: ['op'], placeholderEnv: {} },
    },
    new Map([['op', { ...op, env: before }]]),
  );

  const second = buildAuthBinding(
    {
      id: 'glm',
      baseURL: 'https://op-connect.geoff.cloud/x',
      auth: { profiles: ['op'], placeholderEnv: {} },
    },
    new Map([['op', { ...op, env: after }]]),
  );

  if (!('binding' in first) || !('binding' in second)) {
    throw new Error('expected both selections to resolve');
  }

  expect(second.binding.hash).not.toBe(first.binding.hash);
});

test('it carries the merged profile variables in the binding', () => {
  const planned = buildAuthBinding(
    {
      id: 'glm',
      baseURL: 'https://op-connect.geoff.cloud/x',
      auth: { profiles: ['op'], placeholderEnv: {} },
    },
    new Map([
      [
        'op',
        {
          name: 'op',
          secret: 'op-connect',
          kind: 'custom',
          host: 'op-connect.geoff.cloud',
          header: 'authorization',
          scheme: 'bearer',
          env: { OP_CONNECT_TOKEN: 'imp-broker-placeholder' },
          dependencies: [],
        },
      ],
    ]),
  );

  if (!('binding' in planned)) {
    throw new Error('expected the selection to resolve');
  }

  expect(planned.binding.hash).toMatchInlineSnapshot(
    `"f45088069e3f7be8d9f4e9d7eab1b6a6c0ed9fb84084a4fa8296a15649397cb8"`,
  );

  expect(planned).toStrictEqual({
    binding: {
      agent: 'glm',
      baseURL: 'https://op-connect.geoff.cloud/x',
      profiles: ['op'],
      secrets: [
        {
          secret: 'op-connect',
          kind: 'custom',
          rules: [{ host: 'op-connect.geoff.cloud', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      placeholderEnv: {},
      profileEnv: { OP_CONNECT_TOKEN: 'imp-broker-placeholder' },
      hash: planned.binding.hash,
    },
  });
});
