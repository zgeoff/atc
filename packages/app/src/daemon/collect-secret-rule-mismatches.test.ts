import { expect, test } from 'bun:test';
import { collectSecretRuleMismatches } from './collect-secret-rule-mismatches';

test('it finds no mismatch when impd holds the complete rule set in another order', () => {
  const mismatches = collectSecretRuleMismatches(
    [
      {
        secret: 'glm',
        kind: 'custom',
        rules: [
          { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
          { host: 'open.bigmodel.cn', header: 'authorization', scheme: 'bearer' },
        ],
      },
    ],
    [
      {
        name: 'glm',
        kind: 'custom',
        rules: [
          { host: 'open.bigmodel.cn', header: 'authorization', scheme: 'bearer' },
          { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
        ],
        imps: ['atc-s1'],
      },
    ],
  );

  expect(mismatches).toStrictEqual([]);
});

test('it reports a secret impd does not hold as missing', () => {
  const mismatches = collectSecretRuleMismatches(
    [
      {
        secret: 'glm',
        kind: 'custom',
        rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
      },
    ],
    [],
  );

  expect(mismatches).toStrictEqual([{ secret: 'glm', reason: 'missing' }]);
});

test('it reports a secret of another kind', () => {
  const mismatches = collectSecretRuleMismatches(
    [
      {
        secret: 'glm',
        kind: 'custom',
        rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
      },
    ],
    [
      {
        name: 'glm',
        kind: 'anthropic',
        rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        imps: [],
      },
    ],
  );

  expect(mismatches).toStrictEqual([
    { secret: 'glm', reason: 'kind', expected: 'custom', actual: 'anthropic' },
  ]);
});

test('it reports a secret whose rules send it to a host the binding lacks', () => {
  const mismatches = collectSecretRuleMismatches(
    [
      {
        secret: 'glm',
        kind: 'custom',
        rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
      },
    ],
    [
      {
        name: 'glm',
        kind: 'custom',
        rules: [
          { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
          { host: 'evil.example.com', header: 'authorization', scheme: 'bearer' },
        ],
        imps: [],
      },
    ],
  );

  expect(mismatches).toStrictEqual([
    {
      secret: 'glm',
      reason: 'rules',
      expected: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
      actual: [
        { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
        { host: 'evil.example.com', header: 'authorization', scheme: 'bearer' },
      ],
    },
  ]);
});

test('it reports a secret that lacks one of the binding rules', () => {
  const mismatches = collectSecretRuleMismatches(
    [
      {
        secret: 'glm',
        kind: 'custom',
        rules: [
          { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
          { host: 'open.bigmodel.cn', header: 'authorization', scheme: 'bearer' },
        ],
      },
    ],
    [
      {
        name: 'glm',
        kind: 'custom',
        rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        imps: [],
      },
    ],
  );

  expect(mismatches).toStrictEqual([
    {
      secret: 'glm',
      reason: 'rules',
      expected: [
        { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
        { host: 'open.bigmodel.cn', header: 'authorization', scheme: 'bearer' },
      ],
      actual: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
    },
  ]);
});

test.each([
  ['header', { host: 'api.z.ai', header: 'x-api-key', scheme: 'bearer' as const }],
  ['scheme', { host: 'api.z.ai', header: 'authorization', scheme: 'raw' as const }],
  ['user', { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' as const, user: 'bot' }],
])('it reports a rule whose %s differs', (_field, rule) => {
  const mismatches = collectSecretRuleMismatches(
    [
      {
        secret: 'glm',
        kind: 'custom',
        rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
      },
    ],
    [{ name: 'glm', kind: 'custom', rules: [rule], imps: [] }],
  );

  expect(mismatches).toStrictEqual([
    {
      secret: 'glm',
      reason: 'rules',
      expected: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
      actual: [rule],
    },
  ]);
});

test('it compares each expected secret on its own and ignores secrets the binding does not expect', () => {
  const mismatches = collectSecretRuleMismatches(
    [
      {
        secret: 'glm',
        kind: 'custom',
        rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
      },
      {
        secret: 'judge',
        kind: 'custom',
        rules: [{ host: 'judge.example.com', header: 'authorization', scheme: 'bearer' }],
      },
    ],
    [
      {
        name: 'glm',
        kind: 'custom',
        rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        imps: [],
      },
      {
        name: 'judge',
        kind: 'custom',
        rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
        imps: [],
      },
      {
        name: 'gh',
        kind: 'github',
        rules: [{ host: 'api.github.com', header: 'authorization', scheme: 'bearer' }],
        imps: [],
      },
    ],
  );

  expect(mismatches).toStrictEqual([
    {
      secret: 'judge',
      reason: 'rules',
      expected: [{ host: 'judge.example.com', header: 'authorization', scheme: 'bearer' }],
      actual: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
    },
  ]);
});
