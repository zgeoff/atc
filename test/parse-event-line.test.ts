import { expect, test } from 'bun:test';
import { parseEventLine } from './parse-event-line';

test('it parses an event line into the wire event', () => {
  const event = parseEventLine('{"v":3,"ev":"SessionRemoved","s":"s1"}');

  expect(event).toStrictEqual({ v: 3, ev: 'SessionRemoved', s: 's1' });
});

test('it throws naming the line for a message that is not an event', () => {
  const line = '{"v":3,"id":1,"m":"daemon.ping"}';

  expect(() => parseEventLine(line)).toThrowWithMessage(Error, `not an event line: ${line}`);
});

test('it throws naming the line for text that is not valid JSON', () => {
  expect(() => parseEventLine('not json')).toThrowWithMessage(Error, 'not an event line: not json');
});
