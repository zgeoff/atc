import { expect, test } from 'bun:test';
import { parsePeerFrame } from './parse-peer-frame';

test('it decodes a response with the body its procedure returned', () => {
  expect(parsePeerFrame('{"i":"2","p":{"b":{"json":{"session":"s7"}}}}')).toStrictEqual({
    kind: 'response',
    id: '2',
    status: 200,
    headers: {},
    body: { session: 's7' },
  });
});

test('it decodes a refusal with its status and error body', () => {
  expect(
    parsePeerFrame('{"i":"3","p":{"s":400,"b":{"json":{"code":"bad_args","message":"no"}}}}'),
  ).toStrictEqual({
    kind: 'response',
    id: '3',
    status: 400,
    headers: {},
    body: { code: 'bad_args', message: 'no' },
  });
});

test('it decodes a response that opens a stream as one with no body', () => {
  expect(parsePeerFrame('{"i":"2","p":{"h":{"content-type":"text/event-stream"}}}')).toStrictEqual({
    kind: 'response',
    id: '2',
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: undefined,
  });
});

test('it decodes one event of a stream with its data', () => {
  expect(
    parsePeerFrame('{"i":"2","t":3,"p":{"e":"message","d":{"json":{"ev":"SessionAdded"}}}}'),
  ).toStrictEqual({ kind: 'event', id: '2', event: 'message', data: { ev: 'SessionAdded' } });
});

test('it decodes the abort of a stream', () => {
  expect(parsePeerFrame('{"i":"2","t":4}')).toStrictEqual({ kind: 'abort', id: '2' });
});

test.each(['[1]', '{"p":{}}', '{"i":2,"p":{}}'])(
  'it refuses the line %s as a peer frame',
  (line) => {
    expect(() => parsePeerFrame(line)).toThrowWithMessage(
      TypeError,
      `a peer frame is a JSON object with a string id, not ${line}`,
    );
  },
);
