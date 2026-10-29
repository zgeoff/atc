import { expect, test } from 'bun:test';
import type { GrantScope } from '@atcx/contract';
import { toSessionID } from '@atcx/contract';
import { buildGrantedEventAccess } from './build-granted-event-access';
import { isTreeInReach } from './is-tree-in-reach';

test.each<{ label: string; scopes: readonly GrantScope[]; seen: string[] }>([
  { label: 'read', scopes: ['read'], seen: ['holder', 'child'] },
  { label: 'every scope', scopes: ['read', 'message', 'spawn', 'kill'], seen: ['holder', 'child'] },
  { label: 'spawn alone', scopes: ['spawn'], seen: [] },
  { label: 'message and kill', scopes: ['message', 'kill'], seen: [] },
])('it shows a holder of $label the events of these sessions alone', (row) => {
  const tree = [
    { id: toSessionID('parent'), parent: null, target: 'box', targetIdentity: 'remote:a' },
    {
      id: toSessionID('holder'),
      parent: toSessionID('parent'),
      target: 'box',
      targetIdentity: 'remote:a',
    },
    {
      id: toSessionID('child'),
      parent: toSessionID('parent'),
      target: 'box',
      targetIdentity: 'remote:a',
    },
    { id: toSessionID('stranger'), parent: null, target: 'box', targetIdentity: 'remote:a' },
  ];

  const access = buildGrantedEventAccess(
    toSessionID('holder'),
    {
      scopes: row.scopes,
      grant: { target: 'box', targetIdentity: 'remote:a' },
      parent: toSessionID('parent'),
      spawner: null,
    },
    (id) => id === toSessionID('child'),
  );

  const seen = tree.filter((session) => isTreeInReach(tree, session.id, access));

  expect(seen.map((session) => String(session.id))).toStrictEqual(row.seen);
});

test('it shows a session that holds no atc access no event', () => {
  const tree = [
    { id: toSessionID('holder'), parent: null, target: 'box', targetIdentity: 'remote:a' },
  ];

  const access = buildGrantedEventAccess(toSessionID('holder'), null, () => true);

  expect(isTreeInReach(tree, toSessionID('holder'), access)).toBe(false);
});
