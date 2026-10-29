import { expect, test } from 'bun:test';
import { toSessionID } from '@atcx/contract';
import { buildSessionSetAccess } from './build-session-set-access';
import { buildTargetAccessFromGrants } from './build-target-access-from-grants';
import { isTreeInReach } from './is-tree-in-reach';

test('it reaches a tree whose every session runs on a target the access may use', () => {
  const sessions = [
    { id: toSessionID('lead'), parent: null, target: 'box', targetIdentity: 'remote:a' },
    {
      id: toSessionID('worker'),
      parent: toSessionID('lead'),
      target: 'box',
      targetIdentity: 'remote:a',
    },
  ];

  const access = buildTargetAccessFromGrants([{ target: 'box', targetIdentity: 'remote:a' }]);

  expect(isTreeInReach(sessions, toSessionID('worker'), access)).toBe(true);
});

test('it refuses a tree that holds a session on a target the access may not use', () => {
  const sessions = [
    { id: toSessionID('lead'), parent: null, target: 'local', targetIdentity: 'local-pty' },
    {
      id: toSessionID('worker'),
      parent: toSessionID('lead'),
      target: 'box',
      targetIdentity: 'remote:a',
    },
  ];

  const access = buildTargetAccessFromGrants([{ target: 'box', targetIdentity: 'remote:a' }]);

  expect(isTreeInReach(sessions, toSessionID('worker'), access)).toBe(false);
});

test('it reaches a session a session-set access admits whatever target its tree runs on', () => {
  const sessions = [
    { id: toSessionID('lead'), parent: null, target: 'local', targetIdentity: 'local-pty' },
    {
      id: toSessionID('worker'),
      parent: toSessionID('lead'),
      target: 'box',
      targetIdentity: 'remote:a',
    },
  ];

  const access = buildSessionSetAccess(
    { target: 'box', targetIdentity: 'remote:a' },
    (id) => id === toSessionID('lead'),
  );

  expect(isTreeInReach(sessions, toSessionID('lead'), access)).toBe(true);
});

test('it refuses a session a session-set access leaves out', () => {
  const sessions = [
    { id: toSessionID('lead'), parent: null, target: 'box', targetIdentity: 'remote:a' },
    {
      id: toSessionID('worker'),
      parent: toSessionID('lead'),
      target: 'box',
      targetIdentity: 'remote:a',
    },
  ];

  const access = buildSessionSetAccess(
    { target: 'box', targetIdentity: 'remote:a' },
    (id) => id === toSessionID('worker'),
  );

  expect(isTreeInReach(sessions, toSessionID('lead'), access)).toBe(false);
});

test('it refuses a session the list does not hold under a session-set access that admits it', () => {
  const access = buildSessionSetAccess({ target: 'box', targetIdentity: 'remote:a' }, () => true);

  expect(isTreeInReach([], toSessionID('gone'), access)).toBe(false);
});
