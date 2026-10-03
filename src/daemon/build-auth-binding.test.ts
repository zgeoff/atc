import { expect, test } from 'bun:test';
import { buildAuthBinding } from './build-auth-binding';

test('it plans a binding of the resolved secrets, the placeholders and the base URL', () => {
  expect(
    buildAuthBinding(
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
            dependencies: [],
          },
        ],
      ]),
    ),
  ).toStrictEqual({
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
      hash: 'a3d73e2050ff42dc3cf60f6912e59cd2dc412a5228bf466d460a06dda34817c5',
    },
  });
});

test('it keeps the hash when a profile the binding does not use is edited or added', () => {
  const before = buildAuthBinding(
    {
      id: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: { profiles: ['glm'], placeholderEnv: {} },
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
          dependencies: [],
        },
      ],
      [
        'unused',
        {
          name: 'unused',
          secret: 'other',
          kind: 'custom',
          host: 'other.example.com',
          header: 'authorization',
          scheme: 'bearer',
          dependencies: [],
        },
      ],
    ]),
  );

  const after = buildAuthBinding(
    {
      id: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: { profiles: ['glm'], placeholderEnv: {} },
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
          dependencies: [],
        },
      ],
      [
        'unused',
        {
          name: 'unused',
          secret: 'other',
          kind: 'custom',
          host: 'changed.example.com',
          header: 'x-api-key',
          scheme: 'bearer',
          dependencies: [],
        },
      ],
      [
        'added',
        {
          name: 'added',
          secret: 'added',
          kind: 'custom',
          host: 'added.example.com',
          header: 'authorization',
          scheme: 'bearer',
          dependencies: [],
        },
      ],
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
  const before = buildAuthBinding(
    {
      id: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: { profiles: ['glm'], placeholderEnv: {} },
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
          dependencies: ['judge'],
        },
      ],
      [
        'judge',
        {
          name: 'judge',
          secret: 'judge',
          kind: 'custom',
          host: 'judge.example.com',
          header: 'authorization',
          scheme: 'bearer',
          dependencies: [],
        },
      ],
    ]),
  );

  const after = buildAuthBinding(
    {
      id: 'glm',
      baseURL: 'https://api.z.ai/api/anthropic',
      auth: { profiles: ['glm'], placeholderEnv: {} },
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
          dependencies: ['judge'],
        },
      ],
      [
        'judge',
        {
          name: 'judge',
          secret: 'judge',
          kind: 'custom',
          host: 'judge.example.com',
          header: 'authorization',
          scheme: 'bearer',
          dependencies: [],
          ...change,
        },
      ],
    ]),
  );

  if (!('binding' in before) || !('binding' in after)) {
    throw new Error('expected both selections to resolve');
  }

  expect(after.binding.hash).not.toBe(before.binding.hash);
});

test('it keeps the hash when the selection lists the same profiles in another order', () => {
  const profiles = new Map([
    [
      'glm',
      {
        name: 'glm',
        secret: 'glm',
        kind: 'custom' as const,
        host: 'api.z.ai',
        header: 'authorization',
        scheme: 'bearer' as const,
        dependencies: [],
      },
    ],
    [
      'judge',
      {
        name: 'judge',
        secret: 'judge',
        kind: 'custom' as const,
        host: 'judge.example.com',
        header: 'authorization',
        scheme: 'bearer' as const,
        dependencies: [],
      },
    ],
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
