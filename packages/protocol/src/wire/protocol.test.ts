import { expect, test } from 'bun:test';
import type { ErrorCode } from '@atcx/contract/light';
import { decodeMessage, encodeMessage } from './protocol';

test('#decodeMessage decodes a request with its params', () => {
  const decoded = decodeMessage(
    '{"version":1,"id":7,"method":"session.spawn","params":{"cwd":"/x"}}',
  );

  expect(decoded).toStrictEqual({
    kind: 'request',
    message: { version: 1, id: 7, method: 'session.spawn', params: { cwd: '/x' } },
  });
});

test('#decodeMessage decodes a request without params', () => {
  const decoded = decodeMessage('{"version":1,"id":2,"method":"daemon.ping"}');

  expect(decoded).toStrictEqual({
    kind: 'request',
    message: { version: 1, id: 2, method: 'daemon.ping' },
  });
});

test('#decodeMessage decodes an ok response', () => {
  const decoded = decodeMessage('{"version":1,"id":7,"ok":{"session":"s7"}}');

  expect(decoded).toStrictEqual({
    kind: 'response',
    message: { version: 1, id: 7, ok: { session: 's7' } },
  });
});

test('#decodeMessage decodes an err response with a known code', () => {
  const decoded = decodeMessage(
    '{"version":1,"id":7,"err":{"code":"no_such_session","message":"gone"}}',
  );

  expect(decoded).toStrictEqual({
    kind: 'response',
    message: { version: 1, id: 7, err: { code: 'no_such_session', message: 'gone' } },
  });
});

test('#decodeMessage decodes an event and keeps unknown fields', () => {
  const decoded = decodeMessage(
    '{"version":1,"ev":"SessionOutput","sessionID":"s7","seq":41,"data":"hi"}',
  );

  expect(decoded).toStrictEqual({
    kind: 'event',
    message: { version: 1, ev: 'SessionOutput', sessionID: 's7', seq: 41, data: 'hi' },
  });
});

test('#decodeMessage keeps unknown request fields out of the decoded message', () => {
  const decoded = decodeMessage('{"version":1,"id":3,"method":"daemon.ping","future":"field"}');

  expect(decoded).toStrictEqual({
    kind: 'request',
    message: { version: 1, id: 3, method: 'daemon.ping' },
  });
});

test.each([
  ['not json {', 'not valid JSON'],
  ['{"id":1,"method":"daemon.ping"}', 'missing version'],
  ['{"version":"1","id":1,"method":"daemon.ping"}', 'missing version'],
  ['{"version":1,"method":"daemon.ping"}', 'missing id'],
  ['{"version":1,"id":1}', 'no method, ok, or err'],
  ['{"version":1,"id":1,"err":{"code":7,"message":"x"}}', 'no method, ok, or err'],
])('#decodeMessage reports %s as malformed with the reason %s', (line, reason) => {
  expect(decodeMessage(line)).toStrictEqual({ kind: 'malformed', reason });
});

test('#decodeMessage decodes an unknown error code as internal and keeps its message', () => {
  const decoded = decodeMessage(
    '{"version":4,"id":1,"err":{"code":"not_a_real_code","message":"x"}}',
  );

  expect(decoded).toStrictEqual({
    kind: 'response',
    message: { version: 4, id: 1, err: { code: 'internal', message: 'x' } },
  });
});

test.each<[string, ErrorCode]>([
  ['auth_host_out_of_scope', 'auth_host_out_of_scope'],
  ['auth_imp_out_of_scope', 'internal'],
])('#decodeMessage decodes the error code %s as %s', (code, expected) => {
  const decoded = decodeMessage(`{"version":4,"id":1,"err":{"code":"${code}","message":"x"}}`);

  expect(decoded).toStrictEqual({
    kind: 'response',
    message: { version: 4, id: 1, err: { code: expected, message: 'x' } },
  });
});

test('#decodeMessage keeps the data an error carries', () => {
  const decoded = decodeMessage(
    '{"version":4,"id":1,"err":{"code":"stale_epoch","message":"x","data":{"epoch":2}}}',
  );

  expect(decoded).toStrictEqual({
    kind: 'response',
    message: { version: 4, id: 1, err: { code: 'stale_epoch', message: 'x', data: { epoch: 2 } } },
  });
});

test('#encodeMessage writes a message as one JSON line', () => {
  expect(
    encodeMessage({ version: 1, id: 9, method: 'daemon.hello', params: { client: 'atc/0.1.0' } }),
  ).toBe('{"version":1,"id":9,"method":"daemon.hello","params":{"client":"atc/0.1.0"}}\n');
});

test('#decodeMessage decodes an encoded message back to the original', () => {
  const line = encodeMessage({
    version: 1,
    id: 9,
    method: 'daemon.hello',
    params: { client: 'atc/0.1.0' },
  });

  expect(decodeMessage(line.trimEnd())).toStrictEqual({
    kind: 'request',
    message: { version: 1, id: 9, method: 'daemon.hello', params: { client: 'atc/0.1.0' } },
  });
});

test('#decodeMessage decodes the principal a request acts as', () => {
  expect(
    decodeMessage('{"version":4,"id":3,"method":"session.list","as":"client-a"}'),
  ).toStrictEqual({
    kind: 'request',
    message: { version: 4, id: 3, method: 'session.list', as: 'client-a' },
  });
});

test.each([['5'], ['""'], ['null']])(
  '#decodeMessage reads a request whose principal is %s as malformed',
  (as) => {
    expect(decodeMessage(`{"version":4,"id":3,"method":"session.list","as":${as}}`)).toStrictEqual({
      kind: 'malformed',
      reason: 'as must be a non-empty string',
    });
  },
);

test('#decodeMessage decodes the name of the principal beside it', () => {
  expect(
    decodeMessage(
      '{"version":4,"id":3,"method":"session.list","as":"client-a","asName":"Lantern Notes"}',
    ),
  ).toStrictEqual({
    kind: 'request',
    message: { version: 4, id: 3, method: 'session.list', as: 'client-a', asName: 'Lantern Notes' },
  });
});

test.each([['5'], ['""'], ['null']])(
  '#decodeMessage reads a request whose principal name is %s as malformed',
  (asName) => {
    expect(
      decodeMessage(
        `{"version":4,"id":3,"method":"session.list","as":"client-a","asName":${asName}}`,
      ),
    ).toStrictEqual({ kind: 'malformed', reason: 'asName must be a non-empty string' });
  },
);

test('#decodeMessage reads a request with a principal name and no principal as malformed', () => {
  expect(
    decodeMessage('{"version":4,"id":3,"method":"session.list","asName":"Lantern Notes"}'),
  ).toStrictEqual({ kind: 'malformed', reason: 'asName needs as' });
});
