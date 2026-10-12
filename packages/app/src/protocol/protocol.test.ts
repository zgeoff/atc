import { expect, test } from 'bun:test';
import { decodeMessage, encodeMessage } from './protocol';

test('#decodeMessage decodes a request with its params', () => {
  const decoded = decodeMessage('{"v":1,"id":7,"m":"session.spawn","p":{"cwd":"/x"}}');

  expect(decoded).toStrictEqual({
    kind: 'request',
    msg: { v: 1, id: 7, m: 'session.spawn', p: { cwd: '/x' } },
  });
});

test('#decodeMessage decodes a request without params', () => {
  const decoded = decodeMessage('{"v":1,"id":2,"m":"daemon.ping"}');

  expect(decoded).toStrictEqual({
    kind: 'request',
    msg: { v: 1, id: 2, m: 'daemon.ping' },
  });
});

test('#decodeMessage decodes an ok response', () => {
  const decoded = decodeMessage('{"v":1,"id":7,"ok":{"session":"s7"}}');

  expect(decoded).toStrictEqual({
    kind: 'response',
    msg: { v: 1, id: 7, ok: { session: 's7' } },
  });
});

test('#decodeMessage decodes an err response with a known code', () => {
  const decoded = decodeMessage('{"v":1,"id":7,"err":{"code":"no_such_session","msg":"gone"}}');

  expect(decoded).toStrictEqual({
    kind: 'response',
    msg: { v: 1, id: 7, err: { code: 'no_such_session', msg: 'gone' } },
  });
});

test('#decodeMessage decodes an event and keeps unknown fields', () => {
  const decoded = decodeMessage('{"v":1,"ev":"SessionOutput","s":"s7","seq":41,"d":"hi"}');

  expect(decoded).toStrictEqual({
    kind: 'event',
    msg: { v: 1, ev: 'SessionOutput', s: 's7', seq: 41, d: 'hi' },
  });
});

test('#decodeMessage keeps unknown request fields out of the decoded message', () => {
  const decoded = decodeMessage('{"v":1,"id":3,"m":"daemon.ping","future":"field"}');

  expect(decoded).toStrictEqual({
    kind: 'request',
    msg: { v: 1, id: 3, m: 'daemon.ping' },
  });
});

test.each([
  ['not json {', 'not valid JSON'],
  ['{"id":1,"m":"daemon.ping"}', 'missing v'],
  ['{"v":"1","id":1,"m":"daemon.ping"}', 'missing v'],
  ['{"v":1,"m":"daemon.ping"}', 'missing id'],
  ['{"v":1,"id":1}', 'no m, ok, or err'],
  ['{"v":1,"id":1,"err":{"code":7,"msg":"x"}}', 'no m, ok, or err'],
])('#decodeMessage reports %s as malformed with the reason %s', (line, reason) => {
  expect(decodeMessage(line)).toStrictEqual({ kind: 'malformed', reason });
});

test('#decodeMessage decodes an unknown error code as internal and keeps its message', () => {
  const decoded = decodeMessage('{"v":4,"id":1,"err":{"code":"not_a_real_code","msg":"x"}}');

  expect(decoded).toStrictEqual({
    kind: 'response',
    msg: { v: 4, id: 1, err: { code: 'internal', msg: 'x' } },
  });
});

test('#decodeMessage keeps the data an error carries', () => {
  const decoded = decodeMessage(
    '{"v":4,"id":1,"err":{"code":"stale_epoch","msg":"x","data":{"epoch":2}}}',
  );

  expect(decoded).toStrictEqual({
    kind: 'response',
    msg: { v: 4, id: 1, err: { code: 'stale_epoch', msg: 'x', data: { epoch: 2 } } },
  });
});

test('#encodeMessage writes a message as one JSON line', () => {
  expect(encodeMessage({ v: 1, id: 9, m: 'daemon.hello', p: { client: 'atc/0.1.0' } })).toBe(
    '{"v":1,"id":9,"m":"daemon.hello","p":{"client":"atc/0.1.0"}}\n',
  );
});

test('#decodeMessage decodes an encoded message back to the original', () => {
  const line = encodeMessage({ v: 1, id: 9, m: 'daemon.hello', p: { client: 'atc/0.1.0' } });

  expect(decodeMessage(line.trimEnd())).toStrictEqual({
    kind: 'request',
    msg: { v: 1, id: 9, m: 'daemon.hello', p: { client: 'atc/0.1.0' } },
  });
});

test('#decodeMessage decodes the principal a request acts as', () => {
  expect(decodeMessage('{"v":4,"id":3,"m":"session.list","as":"client-a"}')).toStrictEqual({
    kind: 'request',
    msg: { v: 4, id: 3, m: 'session.list', as: 'client-a' },
  });
});

test.each([['5'], ['""'], ['null']])(
  '#decodeMessage reads a request whose principal is %s as malformed',
  (as) => {
    expect(decodeMessage(`{"v":4,"id":3,"m":"session.list","as":${as}}`)).toStrictEqual({
      kind: 'malformed',
      reason: 'as must be a non-empty string',
    });
  },
);
