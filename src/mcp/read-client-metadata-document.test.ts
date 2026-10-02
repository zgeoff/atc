import { expect, test } from 'bun:test';
import { readClientMetadataDocument } from './read-client-metadata-document';

test('it refuses a client id on a host the operator did not list', async () => {
  const client = await readClientMetadataDocument('https://chatgpt.com/oauth/client.json', []);

  expect(client).toBeNull();
});

test('it refuses a listed client id whose host resolves to loopback', async () => {
  const client = await readClientMetadataDocument('https://localhost/client.json', ['localhost']);

  expect(client).toBeNull();
});

test('it refuses a client id that is not https', async () => {
  const client = await readClientMetadataDocument('http://chatgpt.com/oauth/client.json', [
    'chatgpt.com',
  ]);

  expect(client).toBeNull();
});
