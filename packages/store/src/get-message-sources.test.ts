import { expect, test } from 'bun:test';
import { getMessageSources } from './get-message-sources';

test.each([
  ['delivered', ['queued']],
  ['answered', ['queued', 'delivered']],
  ['unanswered', ['queued', 'delivered']],
  ['queued', []],
] as const)('it lets a message move to %s from %p', (to, sources) => {
  expect(getMessageSources(to)).toStrictEqual([...sources]);
});

test('it narrows the sources to the statuses a write names', () => {
  expect(getMessageSources('unanswered', ['delivered'])).toStrictEqual(['delivered']);
});

test('it refuses a write that names a move the table lacks', () => {
  expect(() => getMessageSources('queued', ['answered'])).toThrow(
    'a message cannot move from answered to queued',
  );
});
