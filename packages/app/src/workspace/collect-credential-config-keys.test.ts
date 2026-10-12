import { expect, test } from 'bun:test';
import { collectCredentialConfigKeys } from './collect-credential-config-keys';

test.each([
  ['a credential helper', 'credential.helper\nstore\0', ['credential.helper']],
  [
    'an http extra header',
    'http.https://x.test/.extraheader\nAuthorization: x\0',
    ['http.https://x.test/.extraheader'],
  ],
  [
    'a remote URL with a token',
    'remote.origin.url\nhttps://t:tok@x.test/r.git\0',
    ['remote.origin.url'],
  ],
  [
    'a rewrite to a URL with userinfo',
    'url.https://t:tok@x.test/.insteadof\nhttps://x.test/\0',
    ['url.https://t:tok@x.test/.insteadof'],
  ],
  ['a token-free remote URL', 'remote.origin.url\nhttps://x.test/r.git\0', []],
  [
    'a partial clone filter',
    'remote.origin.promisor\ntrue\0remote.origin.partialclonefilter\nblob:none\0',
    [],
  ],
])('it finds %s as %j', (_label, listing, expected) => {
  expect(collectCredentialConfigKeys(listing)).toStrictEqual(expected);
});

test('it lists a key set more than once once', () => {
  expect(
    collectCredentialConfigKeys('credential.helper\nstore\0credential.helper\ncache\0'),
  ).toStrictEqual(['credential.helper']);
});
