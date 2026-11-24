import { expect, test } from 'bun:test';
import { buildStubGatewayFetch } from './build-stub-gateway-fetch';

test('it records each request and answers it with the answer at its position', async () => {
  const stub = buildStubGatewayFetch([() => new Response('one'), () => new Response('two')]);

  const first = await stub.fetch(
    new Request('http://gateway.test/rpc/a', {
      method: 'POST',
      headers: { 'x-name': 'first' },
      body: JSON.stringify({ json: 1 }),
    }),
  );

  const second = await stub.fetch(new Request('http://gateway.test/rpc/b', { method: 'POST' }));

  expect([await first.text(), await second.text(), stub.requests]).toStrictEqual([
    'one',
    'two',
    [
      {
        url: 'http://gateway.test/rpc/a',
        method: 'POST',
        headers: expect.objectContaining({ 'x-name': 'first' }),
        body: { json: 1 },
      },
      { url: 'http://gateway.test/rpc/b', method: 'POST', headers: expect.any(Object), body: null },
    ],
  ]);
});

test('it rejects a request that has no answer', () => {
  const stub = buildStubGatewayFetch([]);

  expect(stub.fetch('http://gateway.test/rpc/a')).rejects.toThrow('gave no answer');
});
