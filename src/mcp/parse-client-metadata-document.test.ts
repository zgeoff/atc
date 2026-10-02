import { expect, test } from 'bun:test';
import { parseClientMetadataDocument } from './parse-client-metadata-document';

test('it reads a client metadata document that names its own URL', () => {
  expect(
    parseClientMetadataDocument('https://chatgpt.com/oauth/client.json', {
      client_id: 'https://chatgpt.com/oauth/client.json',
      client_name: 'ChatGPT',
      redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
      token_endpoint_auth_method: 'none',
    }),
  ).toStrictEqual({
    clientID: 'https://chatgpt.com/oauth/client.json',
    name: 'ChatGPT',
    redirectURIs: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    verified: true,
  });
});

test('it names an unnamed client after its host', () => {
  expect(
    parseClientMetadataDocument('https://client.example/meta.json', {
      client_id: 'https://client.example/meta.json',
      redirect_uris: ['https://client.example/cb'],
    }),
  ).toStrictEqual({
    clientID: 'https://client.example/meta.json',
    name: 'client.example',
    redirectURIs: ['https://client.example/cb'],
    verified: true,
  });
});

test('it drops terminal escapes from a document client name', () => {
  expect(
    parseClientMetadataDocument('https://client.example/meta.json', {
      client_id: 'https://client.example/meta.json',
      client_name: 'dots\u001B]52;c;AAAA\u0007\nApprove me',
      redirect_uris: ['https://client.example/cb'],
    }),
  ).toStrictEqual({
    clientID: 'https://client.example/meta.json',
    name: 'dots]52;c;AAAA Approve me',
    redirectURIs: ['https://client.example/cb'],
    verified: true,
  });
});

test('it cuts an overlong document client name to 100 characters', () => {
  expect(
    parseClientMetadataDocument('https://client.example/meta.json', {
      client_id: 'https://client.example/meta.json',
      client_name: 'x'.repeat(5000),
      redirect_uris: ['https://client.example/cb'],
    }),
  ).toStrictEqual({
    clientID: 'https://client.example/meta.json',
    name: 'x'.repeat(100),
    redirectURIs: ['https://client.example/cb'],
    verified: true,
  });
});

test.each([
  [
    'a document for another client id',
    { client_id: 'https://evil.example/meta.json', redirect_uris: ['https://client.example/cb'] },
  ],
  [
    'a document with no redirect URIs',
    { client_id: 'https://client.example/meta.json', redirect_uris: [] },
  ],
  [
    'a document with an http redirect URI',
    { client_id: 'https://client.example/meta.json', redirect_uris: ['http://client.example/cb'] },
  ],
  [
    'a document asking for client secrets',
    {
      client_id: 'https://client.example/meta.json',
      redirect_uris: ['https://client.example/cb'],
      token_endpoint_auth_method: 'client_secret_basic',
    },
  ],
  ['a document that is not an object', ['https://client.example/cb']],
])('it refuses %s', (_label, body) => {
  expect(parseClientMetadataDocument('https://client.example/meta.json', body)).toBeNull();
});
