import { expect, test } from 'bun:test';
import { ORPCError } from '@orpc/client';
import { DaemonError } from '../wire/daemon-error';
import { toDaemonError } from './to-daemon-error';

test('it keeps the code, message and data of a refusal the daemon sent', () => {
  const error = toDaemonError(
    new ORPCError('target_forbidden', {
      message: "target 'box' is out of reach",
      data: { target: 'box' },
    }),
  );

  expect({ code: error.code, message: error.message, data: error.data }).toStrictEqual({
    code: 'target_forbidden',
    message: "target 'box' is out of reach",
    data: { target: 'box' },
  });
});

test('it reads a code the client does not know as internal', () => {
  const error = toDaemonError(new ORPCError('NOT_FOUND', { message: 'Not Found' }));

  expect({ code: error.code, message: error.message }).toStrictEqual({
    code: 'internal',
    message: 'Not Found',
  });
});

test('it passes a daemon error on unchanged', () => {
  const refusal = new DaemonError('protocol_mismatch', 'restart the daemon');

  expect(toDaemonError(refusal)).toBe(refusal);
});

test('it reads any other failure as internal with its message', () => {
  const error = toDaemonError(new Error('socket hang up'));

  expect({ code: error.code, message: error.message }).toStrictEqual({
    code: 'internal',
    message: 'socket hang up',
  });
});
