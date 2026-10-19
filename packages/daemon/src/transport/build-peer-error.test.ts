import { expect, test } from 'bun:test';
import { DaemonError } from '@atc/protocol/wire';
import { ORPCError, ValidationError } from '@orpc/server';
import { buildPeerError } from './build-peer-error';

test('it keeps the code, message and data of a daemon refusal', () => {
  const error = buildPeerError(
    new DaemonError('scope_invalid', 'a scope entry names no path', { entry: 2 }),
  );

  expect({ code: error.code, message: error.message, data: error.data }).toStrictEqual({
    code: 'scope_invalid',
    message: 'a scope entry names no path',
    data: { entry: 2 },
  });
});

test('it refuses params the schema refuses as bad_args with the first issue', () => {
  const error = buildPeerError(
    new ORPCError('BAD_REQUEST', {
      message: 'Input validation failed',
      cause: new ValidationError({
        message: 'Input validation failed',
        issues: [{ message: 'cols must be a number' }, { message: 'rows must be a number' }],
      }),
    }),
  );

  expect({ code: error.code, message: error.message }).toStrictEqual({
    code: 'bad_args',
    message: 'cols must be a number',
  });
});

test('it reports an answer the schema refuses as internal', () => {
  const error = buildPeerError(
    new ORPCError('INTERNAL_SERVER_ERROR', {
      message: 'Output validation failed',
      cause: new ValidationError({
        message: 'Output validation failed',
        issues: [{ message: 'expected a string' }],
      }),
    }),
  );

  expect({ code: error.code, message: error.message }).toStrictEqual({
    code: 'internal',
    message: 'Output validation failed: expected a string',
  });
});

test('it reports any other failure as internal with its message', () => {
  const error = buildPeerError(new Error('the store is closed'));

  expect({ code: error.code, message: error.message }).toStrictEqual({
    code: 'internal',
    message: 'the store is closed',
  });
});
