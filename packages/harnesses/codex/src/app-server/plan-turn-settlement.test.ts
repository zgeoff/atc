import { expect, test } from 'bun:test';
import { planTurnSettlement } from './plan-turn-settlement';

test('it answers the messages of a completed turn with its reply', () => {
  expect(planTurnSettlement('turn-1', 'completed', ['m-1', 'm-2'], 'done')).toStrictEqual({
    kind: 'answered',
    turn: 'turn-1',
    messages: ['m-1', 'm-2'],
    answer: 'done',
  });
});

test.each([
  ['an interrupted turn', 'interrupted', 'done', 'interrupted'],
  ['a failed turn', 'failed', undefined, 'error'],
  ['a completed turn without a reply', 'completed', undefined, 'error'],
])('it leaves the messages of %s unanswered', (_label, status, reply, reason) => {
  expect(planTurnSettlement('turn-1', status, ['m-1'], reply)).toStrictEqual({
    kind: 'unanswered',
    turn: 'turn-1',
    messages: ['m-1'],
    reason,
  });
});

test('it settles nothing for a turn still in progress', () => {
  expect(planTurnSettlement('turn-1', 'inProgress', ['m-1'], 'so far')).toBeNull();
});

test('it settles nothing for a turn that carried no message', () => {
  expect(planTurnSettlement('turn-1', 'completed', [], 'done')).toBeNull();
});
