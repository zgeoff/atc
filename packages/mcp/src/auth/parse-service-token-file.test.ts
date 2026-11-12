import { expect, test } from 'bun:test';
import { parseServiceTokenFile } from './parse-service-token-file';

test('it parses a file of clients with their scopes and tokens', () => {
  const text = JSON.stringify({
    resource: 'https://atc.example.com/mcp',
    clients: {
      'ci-bot': { scopes: ['read', 'message'], tokens: [`atcs_${'a'.repeat(32)}`] },
      watcher: { scopes: ['read'], tokens: [`atcs_${'c'.repeat(32)}`, `atcs_${'b'.repeat(40)}`] },
    },
  });

  expect(parseServiceTokenFile(text)).toStrictEqual({
    ok: true,
    file: {
      resource: 'https://atc.example.com/mcp',
      clients: [
        { name: 'ci-bot', scopes: ['read', 'message'], tokens: [`atcs_${'a'.repeat(32)}`] },
        {
          name: 'watcher',
          scopes: ['read'],
          tokens: [`atcs_${'c'.repeat(32)}`, `atcs_${'b'.repeat(40)}`],
        },
      ],
    },
  });
});

test('it refuses text that is not JSON without quoting the text', () => {
  expect(parseServiceTokenFile(`not json atcs_${'a'.repeat(32)}`)).toStrictEqual({
    ok: false,
    reason: 'the file is not valid JSON',
  });
});

test.each([
  [
    'a root that is not an object',
    '[]',
    'the file: Invalid input: expected object, received array',
  ],
  [
    'a missing resource',
    { clients: { ci: { scopes: ['read'], tokens: [`atcs_${'a'.repeat(32)}`] } } },
    'resource: Invalid input: expected string, received undefined',
  ],
  [
    'a field the file does not take',
    {
      resource: 'r',
      extra: 1,
      clients: { ci: { scopes: ['read'], tokens: [`atcs_${'a'.repeat(32)}`] } },
    },
    'the file: has a field the file does not take',
  ],
  [
    'a field a client does not take',
    {
      resource: 'r',
      clients: { ci: { scopes: ['read'], tokens: [`atcs_${'a'.repeat(32)}`], note: 'x' } },
    },
    'clients.ci: has a field the file does not take',
  ],
  ['no clients', { resource: 'r', clients: {} }, 'clients: must name at least one client'],
  [
    'an empty scope list',
    { resource: 'r', clients: { ci: { scopes: [], tokens: [`atcs_${'a'.repeat(32)}`] } } },
    'clients.ci.scopes: must name at least one scope',
  ],
  [
    'a scope the gateway does not know',
    { resource: 'r', clients: { ci: { scopes: ['admin'], tokens: [`atcs_${'a'.repeat(32)}`] } } },
    'clients.ci.scopes[0]: a scope must be one the gateway knows',
  ],
  [
    'no tokens',
    { resource: 'r', clients: { ci: { scopes: ['read'], tokens: [] } } },
    'clients.ci.tokens: must hold 1 or 2 tokens',
  ],
  [
    'three tokens',
    {
      resource: 'r',
      clients: {
        ci: {
          scopes: ['read'],
          tokens: [`atcs_${'a'.repeat(32)}`, `atcs_${'b'.repeat(40)}`, `atcs_${'c'.repeat(32)}`],
        },
      },
    },
    'clients.ci.tokens: must hold 1 or 2 tokens',
  ],
  [
    'a token without the prefix',
    { resource: 'r', clients: { ci: { scopes: ['read'], tokens: ['b'.repeat(40)] } } },
    'clients.ci.tokens[0]: a token must be atcs_ followed by 32 or more of A-Z, a-z, 0-9, _ and -',
  ],
  [
    'a token with fewer than 32 characters after the prefix',
    { resource: 'r', clients: { ci: { scopes: ['read'], tokens: [`atcs_${'a'.repeat(31)}`] } } },
    'clients.ci.tokens[0]: a token must be atcs_ followed by 32 or more of A-Z, a-z, 0-9, _ and -',
  ],
  [
    'a token with a character outside the set',
    { resource: 'r', clients: { ci: { scopes: ['read'], tokens: [`atcs_${'a'.repeat(31)}.`] } } },
    'clients.ci.tokens[0]: a token must be atcs_ followed by 32 or more of A-Z, a-z, 0-9, _ and -',
  ],
  [
    'a token that is not a string',
    { resource: 'r', clients: { ci: { scopes: ['read'], tokens: [7] } } },
    'clients.ci.tokens[0]: Invalid input: expected string, received number',
  ],
  [
    'the same token under two clients',
    {
      resource: 'r',
      clients: {
        one: { scopes: ['read'], tokens: [`atcs_${'a'.repeat(32)}`] },
        two: { scopes: ['read'], tokens: [`atcs_${'a'.repeat(32)}`] },
      },
    },
    'the same token appears more than once',
  ],
  [
    'the same token twice under one client',
    {
      resource: 'r',
      clients: {
        one: { scopes: ['read'], tokens: [`atcs_${'a'.repeat(32)}`, `atcs_${'a'.repeat(32)}`] },
      },
    },
    'the same token appears more than once',
  ],
])('it refuses %s', (_label, input, reason) => {
  const text = typeof input === 'string' ? input : JSON.stringify(input);

  expect(parseServiceTokenFile(text)).toStrictEqual({ ok: false, reason });
});

test.each([['Upper'], ['1digit'], ['has_underscore'], [''], ['a'.repeat(33)]])(
  'it refuses the client name %p',
  (name) => {
    const text = JSON.stringify({
      resource: 'r',
      clients: { [name]: { scopes: ['read'], tokens: [`atcs_${'a'.repeat(32)}`] } },
    });

    expect(parseServiceTokenFile(text)).toStrictEqual({
      ok: false,
      reason: 'a client name must match [a-z][a-z0-9-]{0,31}',
    });
  },
);

test('it names no token in the reason for a client name that holds one', () => {
  const text = JSON.stringify({
    resource: 'r',
    clients: {
      [`atcs_${'a'.repeat(32)}`]: { scopes: ['read'], tokens: [`atcs_${'b'.repeat(40)}`] },
    },
  });

  const parsed = parseServiceTokenFile(text);

  expect(parsed).toStrictEqual({ ok: false, reason: expect.not.stringContaining('atcs_') });
});

test('it names no token in the reason for a misplaced field', () => {
  const text = JSON.stringify({
    resource: 'r',
    [`atcs_${'a'.repeat(32)}`]: 1,
    clients: { ci: { scopes: ['read'], tokens: [`atcs_${'b'.repeat(40)}`] } },
  });

  expect(parseServiceTokenFile(text)).toStrictEqual({
    ok: false,
    reason: expect.not.stringContaining('atcs_'),
  });
});

test('it keeps each scope once', () => {
  const text = JSON.stringify({
    resource: 'r',
    clients: { ci: { scopes: ['read', 'read'], tokens: [`atcs_${'a'.repeat(32)}`] } },
  });

  expect(parseServiceTokenFile(text)).toStrictEqual({
    ok: true,
    file: {
      resource: 'r',
      clients: [{ name: 'ci', scopes: ['read'], tokens: [`atcs_${'a'.repeat(32)}`] }],
    },
  });
});
