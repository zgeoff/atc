import { expect, test } from 'bun:test';
import { spawnNamedSession } from './spawn-named-session';

test('it sends one session.spawn request carrying the name, cwd, and dims', async () => {
  const sent: unknown[] = [];

  await spawnNamedSession(
    (m, p) => {
      sent.push({ m, p });

      return Promise.resolve({ session: { id: 's1-abc' } });
    },
    'auth-bug',
    '/w',
  );

  expect(sent).toStrictEqual([
    { m: 'session.spawn', p: { cwd: '/w', name: 'auth-bug', cols: 80, rows: 24 } },
  ]);
});

test('it returns the spawned session id from the answer', async () => {
  const id = await spawnNamedSession(
    () => Promise.resolve({ session: { id: 's1-abc' } }),
    'auth-bug',
    '/tmp',
  );

  expect(id).toBe('s1-abc');
});

test('it throws when the answer carries no session id', () => {
  const attempt = spawnNamedSession(() => Promise.resolve({ session: {} }), 'auth-bug', '/tmp');

  expect(attempt).rejects.toThrowWithMessage(Error, 'no session in spawn answer');
});
