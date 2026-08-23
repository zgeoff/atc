import { expect, test } from 'bun:test';
import { decodeMessage, encodeMessage } from './protocol';

test('it decodes a request with its params', () => {
  const decoded = decodeMessage('{"v":1,"id":7,"m":"session.spawn","p":{"cwd":"/x"}}');

  expect(decoded).toStrictEqual({
    kind: 'request',
    msg: { v: 1, id: 7, m: 'session.spawn', p: { cwd: '/x' } },
  });
});

test('it decodes a request without params', () => {
  const decoded = decodeMessage('{"v":1,"id":2,"m":"daemon.ping"}');

  expect(decoded).toStrictEqual({
    kind: 'request',
    msg: { v: 1, id: 2, m: 'daemon.ping' },
  });
});

test('it decodes an ok response', () => {
  const decoded = decodeMessage('{"v":1,"id":7,"ok":{"session":"s7"}}');

  expect(decoded).toStrictEqual({
    kind: 'response',
    msg: { v: 1, id: 7, ok: { session: 's7' } },
  });
});

test('it decodes an err response with a known code', () => {
  const decoded = decodeMessage('{"v":1,"id":7,"err":{"code":"no_such_session","msg":"gone"}}');

  expect(decoded).toStrictEqual({
    kind: 'response',
    msg: { v: 1, id: 7, err: { code: 'no_such_session', msg: 'gone' } },
  });
});

test('it decodes an event and keeps unknown fields', () => {
  const decoded = decodeMessage('{"v":1,"ev":"session.output","s":"s7","seq":41,"d":"hi"}');

  expect(decoded).toStrictEqual({
    kind: 'event',
    msg: { v: 1, ev: 'session.output', s: 's7', seq: 41, d: 'hi' },
  });
});

test('it keeps unknown request fields out of the decoded message', () => {
  const decoded = decodeMessage('{"v":1,"id":3,"m":"daemon.ping","future":"field"}');

  expect(decoded).toStrictEqual({
    kind: 'request',
    msg: { v: 1, id: 3, m: 'daemon.ping' },
  });
});

test.each([
  ['not valid JSON', 'not json {'],
  ['missing v', '{"id":1,"m":"daemon.ping"}'],
  ['missing v', '{"v":"1","id":1,"m":"daemon.ping"}'],
  ['missing id', '{"v":1,"m":"daemon.ping"}'],
  ['no m, ok, or err', '{"v":1,"id":1}'],
  ['no m, ok, or err', '{"v":1,"id":1,"err":{"code":"not_a_real_code","msg":"x"}}'],
])('it reports %s as malformed', (reason, line) => {
  expect(decodeMessage(line)).toStrictEqual({ kind: 'malformed', reason });
});

test('it round-trips a message through encode and decode', () => {
  const line = encodeMessage({ v: 1, id: 9, m: 'daemon.hello', p: { client: 'atc/0.1.0' } });

  expect(line).toEndWith('\n');

  expect(decodeMessage(line.trimEnd())).toStrictEqual({
    kind: 'request',
    msg: { v: 1, id: 9, m: 'daemon.hello', p: { client: 'atc/0.1.0' } },
  });
});
