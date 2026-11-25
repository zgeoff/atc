import { expect, test } from 'bun:test';
import { CONTRACT_MAJOR } from '@atcx/contract/light';
import { buildRPCRequest } from './build-rpc-request';

test('it builds a POST that carries the input, the bearer and the major version', async () => {
  const request = buildRPCRequest('session/list', { name: 'one' }, 'tok');

  expect({
    method: request.method,
    url: request.url,
    authorization: request.headers.get('authorization'),
    major: request.headers.get('x-atc-major'),
    body: await request.json(),
  }).toStrictEqual({
    method: 'POST',
    url: 'http://gateway.test/rpc/session/list',
    authorization: 'Bearer tok',
    major: String(CONTRACT_MAJOR),
    body: { json: { name: 'one' } },
  });
});

test('it sends no Authorization header without a bearer', () => {
  expect(buildRPCRequest('session/list', {}, null).headers.get('authorization')).toBeNull();
});

test('it lets a header override replace the major version', () => {
  const request = buildRPCRequest('session/list', {}, 'tok', { headers: { 'x-atc-major': '1' } });

  expect(request.headers.get('x-atc-major')).toBe('1');
});
