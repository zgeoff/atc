import { expect, test } from 'bun:test';
import { toSessionID } from '../shared/to-session-id';
import { isBindingCurrent } from './is-binding-current';

test('it holds a binding current while the live session matches it in every field', () => {
  const current = isBindingCurrent(
    {
      sessionID: toSessionID('s1'),
      target: 'box',
      targetIdentity: 'imp:a',
      hostKey: toSessionID('p1'),
      epoch: 3,
    },
    {
      id: toSessionID('s1'),
      target: 'box',
      targetIdentity: 'imp:a',
      hostKey: toSessionID('p1'),
      bridgeEpoch: 3,
    },
  );

  expect(current).toBeTrue();
});

test('it holds a binding stale once its session is gone', () => {
  const current = isBindingCurrent(
    {
      sessionID: toSessionID('s1'),
      target: 'box',
      targetIdentity: 'imp:a',
      hostKey: toSessionID('p1'),
      epoch: 3,
    },
    undefined,
  );

  expect(current).toBeFalse();
});

test.each([
  ['id', { id: toSessionID('s2') }],
  ['target', { target: 'other' }],
  ['target identity', { targetIdentity: 'imp:b' }],
  ['host key', { hostKey: toSessionID('s1') }],
  ['epoch', { bridgeEpoch: 4 }],
])('it holds a binding stale once the live session differs in its %s', (_field, change) => {
  const current = isBindingCurrent(
    {
      sessionID: toSessionID('s1'),
      target: 'box',
      targetIdentity: 'imp:a',
      hostKey: toSessionID('p1'),
      epoch: 3,
    },
    {
      id: toSessionID('s1'),
      target: 'box',
      targetIdentity: 'imp:a',
      hostKey: toSessionID('p1'),
      bridgeEpoch: 3,
      ...change,
    },
  );

  expect(current).toBeFalse();
});
