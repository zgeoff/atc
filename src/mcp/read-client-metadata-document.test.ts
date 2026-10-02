import { expect, test } from 'bun:test';
import { readClientMetadataDocument } from './read-client-metadata-document';

function setupTest() {
  const counter = { connections: 0 };

  const listener = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(socket) {
        counter.connections += 1;

        socket.end();
      },
      data() {
        // The listener only counts connections; it reads nothing.
      },
    },
  });

  return {
    clientID: `https://localhost:${listener.port}/client.json`,
    counter,
    [Symbol.dispose]() {
      listener.stop(true);
    },
  };
}

test('it refuses a client id on a host the operator did not list', async () => {
  const client = await readClientMetadataDocument('https://chatgpt.com/oauth/client.json', []);

  expect(client).toBeNull();
});

test('it refuses a listed localhost client id through the system resolver without connecting', async () => {
  using listener = setupTest();

  const client = await readClientMetadataDocument(listener.clientID, ['localhost']);

  expect(client).toBeNull();
  expect(listener.counter.connections).toBe(0);
});

test('it refuses a listed client id whose host resolves to loopback without connecting', async () => {
  using listener = setupTest();

  const client = await readClientMetadataDocument(listener.clientID, ['localhost'], () =>
    Promise.resolve([{ address: '127.0.0.1' }]),
  );

  expect(client).toBeNull();
  expect(listener.counter.connections).toBe(0);
});

test('it connects for a listed client id whose host resolves only to public addresses', async () => {
  using listener = setupTest();

  const client = await readClientMetadataDocument(listener.clientID, ['localhost'], () =>
    Promise.resolve([{ address: '93.184.216.34' }]),
  );

  expect(client).toBeNull();
  expect(listener.counter.connections).toBe(1);
});

test('it refuses a listed client id when any address its host resolves to is private', async () => {
  using listener = setupTest();

  const client = await readClientMetadataDocument(listener.clientID, ['localhost'], () =>
    Promise.resolve([{ address: '93.184.216.34' }, { address: '10.0.0.1' }]),
  );

  expect(client).toBeNull();
  expect(listener.counter.connections).toBe(0);
});

test('it refuses a listed client id whose host does not resolve without connecting', async () => {
  using listener = setupTest();

  const client = await readClientMetadataDocument(listener.clientID, ['localhost'], () =>
    Promise.resolve([]),
  );

  expect(client).toBeNull();
  expect(listener.counter.connections).toBe(0);
});

test('it refuses a client id that is not https', async () => {
  const client = await readClientMetadataDocument('http://chatgpt.com/oauth/client.json', [
    'chatgpt.com',
  ]);

  expect(client).toBeNull();
});
