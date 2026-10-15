import { expect, test } from 'bun:test';
import { parseAppServerTurn } from './parse-app-server-turn';

test('it reads a turn with the items it can read and leaves the others out', () => {
  expect(
    parseAppServerTurn({
      id: 'turn-1',
      status: 'completed',
      items: [
        { type: 'userMessage', id: 'i-1', clientId: 'm-1', content: [] },
        { type: 'agentMessage', id: 'i-2', text: 'done', phase: 'final_answer' },
        { id: 'i-3' },
        { type: 'reasoning', clientId: null },
      ],
    }),
  ).toStrictEqual({
    id: 'turn-1',
    status: 'completed',
    items: [
      { type: 'userMessage', clientId: 'm-1' },
      { type: 'agentMessage', text: 'done' },
      { type: 'reasoning' },
    ],
  });
});

test('it reads a turn sent without items as one with none', () => {
  expect(parseAppServerTurn({ id: 'turn-1', status: 'inProgress' })).toStrictEqual({
    id: 'turn-1',
    status: 'inProgress',
    items: [],
  });
});

test('it reads a value without an id as no turn', () => {
  expect(parseAppServerTurn({ status: 'completed', items: [] })).toBeNull();
});
