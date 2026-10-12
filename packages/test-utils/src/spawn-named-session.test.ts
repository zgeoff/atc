import { expect, mock, test } from 'bun:test';
import { spawnNamedSession } from './spawn-named-session';

test('it sends one session.spawn request carrying the name, cwd, and dims', async () => {
  const send = mock(() => Promise.resolve({ session: { id: 's1-abc' } }));

  await spawnNamedSession(send, 'auth-bug', '/w');

  expect(send).toHaveBeenCalledExactlyOnceWith('session.spawn', {
    cwd: '/w',
    name: 'auth-bug',
    cols: 80,
    rows: 24,
  });
});

test('it returns the spawned session id from the answer', async () => {
  const id = await spawnNamedSession(
    () => Promise.resolve({ session: { id: 's1-abc' } }),
    'auth-bug',
    '/w',
  );

  expect(id).toBe('s1-abc');
});

test('it throws when the answer carries no session id', () => {
  const attempt = spawnNamedSession(() => Promise.resolve({ session: {} }), 'auth-bug', '/w');

  expect(attempt).rejects.toThrowWithMessage(Error, 'no session in spawn answer');
});

test('it throws when the answer carries no session', () => {
  const attempt = spawnNamedSession(() => Promise.resolve({}), 'auth-bug', '/w');

  expect(attempt).rejects.toThrowWithMessage(Error, 'no session in spawn answer');
});
