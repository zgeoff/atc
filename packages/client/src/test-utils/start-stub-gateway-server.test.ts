import { expect, onTestFinished, test } from 'bun:test';
import { startStubGatewayServer } from './start-stub-gateway-server';

test('it records each request and answers it with the answer at its position', async () => {
  const server = startStubGatewayServer([() => new Response('one'), () => new Response('two')]);

  onTestFinished(async () => {
    await server.stop();
  });

  const first = await fetch(`${server.url}/rpc/a`, {
    method: 'POST',
    headers: { 'x-name': 'first' },
    body: JSON.stringify({ json: 1 }),
  });

  const second = await fetch(`${server.url}/rpc/b`, { method: 'POST' });

  expect([await first.text(), await second.text(), server.requests]).toStrictEqual([
    'one',
    'two',
    [
      {
        url: '/rpc/a',
        method: 'POST',
        headers: expect.objectContaining({ 'x-name': 'first' }),
        body: { json: 1 },
      },
      { url: '/rpc/b', method: 'POST', headers: expect.any(Object), body: null },
    ],
  ]);
});

test('it answers a request that has no answer with a 500', async () => {
  const server = startStubGatewayServer([]);

  onTestFinished(async () => {
    await server.stop();
  });

  const response = await fetch(`${server.url}/rpc/a`, { method: 'POST' });

  expect(response.status).toBe(500);
});
