import { expect, test } from 'bun:test';
import { buildMockAuthProfile } from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { buildAuthBinding } from './build-auth-binding';

test('it plans a binding of the resolved secrets, the placeholders and the base URL', () => {
  const planned = buildAuthBinding(
    {
      id: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: {
        profiles: ['glm'],
        placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
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

  invariant('binding' in planned, 'expected the selection to resolve');

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
      placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
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

  invariant('binding' in before && 'binding' in after, 'expected both selections to resolve');

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

  invariant('binding' in before && 'binding' in after, 'expected both selections to resolve');

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

  invariant('binding' in before && 'binding' in after, 'expected both selections to resolve');

  expect(after.binding.hash).toBe(before.binding.hash);
});

test('it refuses to plan a binding whose profiles collide on one host', () => {
  const profiles = new Map([
    ['glm', buildMockAuthProfile({ name: 'glm', host: 'api.z.ai' })],
    ['judge', buildMockAuthProfile({ name: 'judge', host: 'api.z.ai' })],
  ]);

  expect(
    buildAuthBinding(
      {
        id: 'glm',
        baseURL: 'https://api.z.ai/api/anthropic',
        auth: { profiles: ['glm', 'judge'], placeholderEnv: {} },
      },
      profiles,
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
      baseURL: 'https://op-connect.example.com/x',
      auth: { profiles: ['op'], placeholderEnv: {} },
    },
    new Map([
      [
        'op',
        {
          name: 'op',
          secret: 'op-connect',
          kind: 'custom',
          host: 'op-connect.example.com',
          header: 'authorization',
          scheme: 'bearer',
          env: {},
          dependencies: [],
        },
      ],
    ]),
  );

  invariant('binding' in planned, 'expected the selection to resolve');

  expect(planned.binding.hash).toMatchInlineSnapshot(
    `"b069b6bfe1d9eab31b295a52237ca9172b0dad2afddd6687cd5c4f534e9aaa14"`,
  );

  expect(planned).toStrictEqual({
    binding: {
      agent: 'glm',
      baseURL: 'https://op-connect.example.com/x',
      profiles: ['op'],
      secrets: [
        {
          secret: 'op-connect',
          kind: 'custom',
          rules: [{ host: 'op-connect.example.com', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      placeholderEnv: {},
      profileEnv: {},
      hash: planned.binding.hash,
    },
  });
});

test.each([
  [{}, { OP_CONNECT_TOKEN: 'broker-placeholder' }],
  [{}, { OP_CONNECT_HOST: 'https://op-connect.example.com' }],
  [
    { OP_CONNECT_TOKEN: 'broker-placeholder' },
    { OP_CONNECT_HOST: 'https://op-connect.example.com' },
  ],
  [{ OP_CONNECT_TOKEN: 'broker-placeholder' }, { OP_CONNECT_TOKEN: 'another-placeholder' }],
])('it moves the hash when the profile variables change from %o to %o', (before, after) => {
  const op = buildMockAuthProfile({ name: 'op' });

  const first = buildAuthBinding(
    {
      id: 'glm',
      baseURL: 'https://op-connect.example.com/x',
      auth: { profiles: ['op'], placeholderEnv: {} },
    },
    new Map([['op', { ...op, env: before }]]),
  );

  const second = buildAuthBinding(
    {
      id: 'glm',
      baseURL: 'https://op-connect.example.com/x',
      auth: { profiles: ['op'], placeholderEnv: {} },
    },
    new Map([['op', { ...op, env: after }]]),
  );

  invariant('binding' in first && 'binding' in second, 'expected both selections to resolve');

  expect(second.binding.hash).not.toBe(first.binding.hash);
});

test('it carries the merged profile variables in the binding', () => {
  const planned = buildAuthBinding(
    {
      id: 'glm',
      baseURL: 'https://op-connect.example.com/x',
      auth: { profiles: ['op'], placeholderEnv: {} },
    },
    new Map([
      [
        'op',
        {
          name: 'op',
          secret: 'op-connect',
          kind: 'custom',
          host: 'op-connect.example.com',
          header: 'authorization',
          scheme: 'bearer',
          env: { OP_CONNECT_TOKEN: 'broker-placeholder' },
          dependencies: [],
        },
      ],
    ]),
  );

  invariant('binding' in planned, 'expected the selection to resolve');

  expect(planned.binding.hash).toMatchInlineSnapshot(
    `"3ca135b025275a5f9e5d8ecf8f838a8069cbab923f163df3ead753d4347d3f72"`,
  );

  expect(planned).toStrictEqual({
    binding: {
      agent: 'glm',
      baseURL: 'https://op-connect.example.com/x',
      profiles: ['op'],
      secrets: [
        {
          secret: 'op-connect',
          kind: 'custom',
          rules: [{ host: 'op-connect.example.com', header: 'authorization', scheme: 'bearer' }],
        },
      ],
      placeholderEnv: {},
      profileEnv: { OP_CONNECT_TOKEN: 'broker-placeholder' },
      hash: planned.binding.hash,
    },
  });
});
