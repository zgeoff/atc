import { expect, test } from 'bun:test';
import { planLeftThreadRecovery } from './plan-left-thread-recovery';

test('it settles the messages a left thread took and keeps the ones it never took', () => {
  const recovery = planLeftThreadRecovery(
    [
      { id: 'm-done', status: 'queued' },
      { id: 'm-running', status: 'queued' },
      { id: 'm-untaken', status: 'queued' },
    ],
    [
      {
        id: 'turn-3',
        status: 'inProgress',
        items: [{ type: 'userMessage', clientId: 'm-running' }],
      },
      {
        id: 'turn-2',
        status: 'completed',
        items: [
          { type: 'userMessage', clientId: 'm-done' },
          { type: 'agentMessage', text: 'the build passes' },
        ],
      },
    ],
  );

  expect(recovery).toStrictEqual({
    acks: ['m-done', 'm-running'],
    settlements: [
      { kind: 'answered', turn: 'turn-2', messages: ['m-done'], answer: 'the build passes' },
    ],
    stranded: ['m-running'],
    kept: [{ id: 'm-untaken', status: 'queued' }],
  });
});

test('it strands every message when the left thread could not be read', () => {
  expect(
    planLeftThreadRecovery(
      [
        { id: 'm-1', status: 'queued' },
        { id: 'm-2', status: 'queued' },
      ],
      null,
    ),
  ).toStrictEqual({ acks: [], settlements: [], stranded: ['m-1', 'm-2'], kept: [] });
});
