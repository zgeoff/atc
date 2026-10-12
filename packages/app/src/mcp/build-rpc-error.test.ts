import { expect, test } from 'bun:test';
import { buildRPCError } from './build-rpc-error';

test('it builds a JSON-RPC error body for a request id', () => {
  expect(buildRPCError(7, -32_601, "unknown method 'x'")).toStrictEqual({
    jsonrpc: '2.0',
    id: 7,
    error: { code: -32_601, message: "unknown method 'x'" },
  });
});

test('it builds a JSON-RPC error body with a null id for no request', () => {
  expect(buildRPCError(null, -32_700, 'parse error')).toStrictEqual({
    jsonrpc: '2.0',
    id: null,
    error: { code: -32_700, message: 'parse error' },
  });
});
