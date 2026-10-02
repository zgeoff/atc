import { expect, test } from 'bun:test';
import { hasRedirectURI } from './has-redirect-uri';

test('it matches a registered redirect URI exactly', () => {
  expect(hasRedirectURI(['https://chatgpt.com/cb'], 'https://chatgpt.com/cb')).toBeTrue();
});

test('it refuses a redirect URI that differs only by a trailing slash', () => {
  expect(hasRedirectURI(['https://chatgpt.com/cb'], 'https://chatgpt.com/cb/')).toBeFalse();
});

test('it matches a loopback redirect URI on a different port', () => {
  expect(
    hasRedirectURI(['http://127.0.0.1:5000/callback'], 'http://127.0.0.1:61234/callback'),
  ).toBeTrue();
});

test('it refuses a loopback redirect URI with a different path', () => {
  expect(
    hasRedirectURI(['http://127.0.0.1:5000/callback'], 'http://127.0.0.1:5000/other'),
  ).toBeFalse();
});
