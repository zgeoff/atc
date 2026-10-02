import { expect, test } from 'bun:test';
import { isAllowedRedirectURI } from './is-allowed-redirect-uri';

test.each([
  ['https://chatgpt.com/connector_platform_oauth_redirect'],
  ['http://127.0.0.1:33418/callback'],
  ['http://localhost/callback'],
])('it allows %p as a redirect URI', (uri) => {
  expect(isAllowedRedirectURI(uri)).toBeTrue();
});

test.each([
  ['http://example.com/callback'],
  ['https://example.com/callback#frag'],
  ['https://user@example.com/callback'],
  ['ftp://example.com/callback'],
  ['not a uri'],
])('it refuses %p as a redirect URI', (uri) => {
  expect(isAllowedRedirectURI(uri)).toBeFalse();
});
