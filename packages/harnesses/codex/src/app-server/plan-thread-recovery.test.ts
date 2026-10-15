import { expect, test } from 'bun:test';
import { planThreadRecovery } from './plan-thread-recovery';

test('it settles each message from the stored turn that holds it', () => {
  const recovery = planThreadRecovery(
    [
      { id: 'm-done', status: 'delivered' },
      { id: 'm-taken', status: 'queued' },
      { id: 'm-stopped', status: 'delivered' },
      { id: 'm-running', status: 'delivered' },
      { id: 'm-lost', status: 'delivered' },
      { id: 'm-unsent', status: 'queued' },
    ],
    [
      {
        id: 'turn-4',
        status: 'inProgress',
        items: [
          { type: 'userMessage', clientId: 'm-running' },
          { type: 'agentMessage', text: 'looking' },
        ],
      },
      {
        id: 'turn-3',
        status: 'interrupted',
        items: [{ type: 'userMessage', clientId: 'm-stopped' }],
      },
      {
        id: 'turn-2',
        status: 'completed',
        items: [
          { type: 'userMessage', clientId: 'm-done' },
          { type: 'userMessage', clientId: 'm-taken' },
          { type: 'agentMessage', text: 'first' },
          { type: 'agentMessage', text: 'both done' },
        ],
      },
    ],
  );

  expect(recovery).toStrictEqual({
    acks: ['m-taken'],
    settlements: [
      { kind: 'answered', turn: 'turn-2', messages: ['m-done', 'm-taken'], answer: 'both done' },
      { kind: 'unanswered', turn: 'turn-3', messages: ['m-stopped'], reason: 'interrupted' },
    ],
    lost: ['m-lost'],
    carried: new Map([['m-running', 'turn-4']]),
    replies: new Map([['turn-4', 'looking']]),
  });
});

test('it leaves every message as it was when there are no stored turns', () => {
  expect(planThreadRecovery([{ id: 'm-unsent', status: 'queued' }], [])).toStrictEqual({
    acks: [],
    settlements: [],
    lost: [],
    carried: new Map(),
    replies: new Map(),
  });
});
