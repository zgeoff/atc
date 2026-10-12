import { expect, test } from 'bun:test';
import { DaemonError } from '../protocol/daemon-error';
import { trySendRequest } from './try-send-request';

test('it returns an answer with the id replaced', async () => {
  const answer = await trySendRequest(
    () => Promise.resolve({ session: { id: 's-1', parent: 's-1' } }),
    's-1',
  );

  expect(answer).toStrictEqual({ ok: { session: { id: '<id>', parent: '<id>' } } });
});

test('it returns a refusal as its code, message, and data with the id replaced', async () => {
  const answer = await trySendRequest(
    () => Promise.reject(new DaemonError('no_such_session', 'no session s-1', { session: 's-1' })),
    's-1',
  );

  expect(answer).toStrictEqual({
    error: { code: 'no_such_session', message: 'no session <id>', data: { session: '<id>' } },
  });
});

test('it returns a refusal without data as holding null data', async () => {
  const answer = await trySendRequest(
    () => Promise.reject(new DaemonError('unauthorized', 'not yours')),
    's-1',
  );

  expect(answer).toStrictEqual({
    error: { code: 'unauthorized', message: 'not yours', data: null },
  });
});

test('it rejects with a failure that is not a daemon refusal', () => {
  expect(
    trySendRequest(() => Promise.reject(new TypeError('socket closed')), 's-1'),
  ).rejects.toThrowWithMessage(TypeError, 'socket closed');
});
