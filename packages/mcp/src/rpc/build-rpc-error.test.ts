import { expect, test } from 'bun:test';
import { AtcError } from '@atcx/contract/light';
import { ORPCError } from '@orpc/server';
import { buildRPCError } from './build-rpc-error';

test('it keeps the code and message and the allowed data of an error', () => {
  const error = buildRPCError(
    new AtcError('no_such_session', 'no session', {
      problem: 'gone',
      required: ['read'],
      effectRef: 'a.b.c',
      secret: 'x',
    }),
  );

  expect([error.code, error.message, error.data, error.defined]).toStrictEqual([
    'no_such_session',
    'no session',
    { problem: 'gone', required: ['read'], effectRef: 'a.b.c' },
    true,
  ]);
});

test('it drops an effectRef marked as restored from the key binding cache', () => {
  const error = buildRPCError(
    new AtcError('outcome_unknown', 'unknown', { effectRef: 'a.b.c', effectRefIsCached: true }),
  );

  expect(error.data).toBeUndefined();
});

test('it keeps a gatewayMajor on protocol_mismatch only when the route sets it', () => {
  const given = buildRPCError(new AtcError('protocol_mismatch', 'old', { gatewayMajor: 1 }), {
    gatewayMajor: 7,
  });

  const unset = buildRPCError(new AtcError('protocol_mismatch', 'old', { gatewayMajor: 1 }));

  expect([given.data, unset.data]).toStrictEqual([{ gatewayMajor: 7 }, undefined]);
});

test('it shows the message of the error an uncoded failure wrapped, as /mcp does', () => {
  const wrapped = Object.assign(new Error('failed', { cause: new Error('connection closed') }), {
    code: 'internal',
  });

  expect(buildRPCError(wrapped).message).toBe('connection closed');
});

test('it reads an oRPC error from the router as it reads an AtcError', () => {
  const error = buildRPCError(
    new ORPCError('insufficient_scope', { message: 'lacks kill', data: { required: ['kill'] } }),
  );

  expect([error.code, error.data]).toStrictEqual(['insufficient_scope', { required: ['kill'] }]);
});

test('it answers an error with no code as internal', () => {
  expect(buildRPCError(new Error('boom')).code).toBe('internal');
});
