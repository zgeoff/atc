import { expect, test } from 'bun:test';
import { collectRedirectURIs } from './collect-redirect-uris';

test('it collects every redirect URI flag in order', () => {
  expect(
    collectRedirectURIs([
      'Claude',
      '--redirect-uri',
      'https://claude.ai/api/mcp/auth_callback',
      '--redirect-uri=https://claude.com/api/mcp/auth_callback',
    ]),
  ).toStrictEqual([
    'https://claude.ai/api/mcp/auth_callback',
    'https://claude.com/api/mcp/auth_callback',
  ]);
});

test('it collects nothing from a trailing flag with no value', () => {
  expect(collectRedirectURIs(['Claude', '--redirect-uri'])).toStrictEqual([]);
});
