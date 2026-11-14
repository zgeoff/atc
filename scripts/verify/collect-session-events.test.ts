import { expect, test } from 'bun:test';
import { collectSessionEvents } from './collect-session-events.ts';

test('it keeps the events of the named session in the order they were printed', () => {
  const lines = [
    JSON.stringify({
      ev: 'SessionAdded',
      version: 1,
      session: { name: 'wv-plum', state: 'running' },
    }),
    JSON.stringify({
      ev: 'SessionAdded',
      version: 1,
      session: { name: 'wv-fig', state: 'running' },
    }),
    JSON.stringify({ ev: 'PermissionResolved', version: 1, decision: 'allow' }),
    JSON.stringify({
      ev: 'SessionState',
      version: 1,
      session: { name: 'wv-plum', state: 'exited' },
    }),
  ];

  expect(collectSessionEvents(lines, 'wv-plum')).toStrictEqual([
    { ev: 'SessionAdded', state: 'running' },
    { ev: 'SessionState', state: 'exited' },
  ]);
});

test('it leaves out a line that is not JSON', () => {
  const lines = [
    'atc events: the daemon closed the stream',
    JSON.stringify({ ev: 'SessionAdded', session: { name: 'wv-plum', state: 'running' } }),
  ];

  expect(collectSessionEvents(lines, 'wv-plum')).toStrictEqual([
    { ev: 'SessionAdded', state: 'running' },
  ]);
});
