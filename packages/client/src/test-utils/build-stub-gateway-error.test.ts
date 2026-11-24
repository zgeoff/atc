import { expect, test } from 'bun:test';
import { buildStubGatewayError } from './build-stub-gateway-error';

test('it answers with status 500 and the oRPC error body of the code', async () => {
  const response = buildStubGatewayError('bad_args');

  const body: unknown = await response.json();

  expect([response.status, body]).toStrictEqual([
    500,
    { json: { defined: true, code: 'bad_args', status: 500, message: 'bad_args happened' } },
  ]);
});
