import { expect, test } from 'bun:test';
import { buildRedirectURL } from './build-redirect-url';

test('it adds the response parameters and the issuer to the redirect URI', () => {
  expect(
    buildRedirectURL(
      'https://dots.example/cb?keep=1',
      { code: 'atc_ac_x', state: 'abc' },
      'https://mcp.example.com',
    ),
  ).toBe(
    'https://dots.example/cb?keep=1&code=atc_ac_x&state=abc&iss=https%3A%2F%2Fmcp.example.com',
  );
});

test('it leaves out a parameter the request never sent', () => {
  expect(
    buildRedirectURL(
      'https://dots.example/cb',
      { error: 'access_denied', state: null },
      'https://mcp.example.com',
    ),
  ).toBe('https://dots.example/cb?error=access_denied&iss=https%3A%2F%2Fmcp.example.com');
});
