import { expect, test } from 'bun:test';
import { resolveDaemonRequest } from './resolve-daemon-request';

test('it routes a request by its session id and hands the daemon its own id', () => {
  const cloud = {
    name: 'cloud',
    address: { host: '100.64.0.2', port: 8415 },
    daemonID: '0f6c2a8e-3d51-4b7a-9c2e-5a8d1e4f7b30',
    incarnation: '0f6c2a8e',
    token: 't',
  };

  const resolved = resolveDaemonRequest(
    { session: 'cloud.0f6c2a8e.s1', text: 'hi' },
    { daemons: new Map([['cloud', cloud]]), defaultDaemon: 'cloud' },
  );

  expect(resolved).toStrictEqual({
    daemon: cloud,
    params: { session: 's1', text: 'hi' },
    requestIDs: new Map([['s1', 'cloud.0f6c2a8e.s1']]),
  });
});

test('it routes a request without an id nowhere and leaves its params alone', () => {
  const resolved = resolveDaemonRequest(
    { cwd: '/tmp' },
    { daemons: new Map(), defaultDaemon: 'cloud' },
  );

  expect(resolved).toStrictEqual({ daemon: null, params: { cwd: '/tmp' }, requestIDs: new Map() });
});

test.each([
  [
    'a stale incarnation',
    { session: 'cloud.11111111.s1' },
    'no_such_session',
    "no session 'cloud.11111111.s1'",
  ],
  [
    'an unknown daemon',
    { session: 'pc.0f6c2a8e.s1' },
    'no_such_session',
    "no session 'pc.0f6c2a8e.s1'",
  ],
  ['a malformed session id', { session: 's1' }, 'no_such_session', "no session 's1'"],
  ['a malformed parent', { parent: 's1' }, 'no_such_session', "no session 's1'"],
  ['a malformed message id', { message: 'm-1' }, 'bad_args', "no message 'm-1'"],
])('it refuses %s as a daemon refuses an id it never held', (_label, params, code, message) => {
  const registry = {
    daemons: new Map([
      [
        'cloud',
        {
          name: 'cloud',
          address: { host: '100.64.0.2', port: 8415 },
          daemonID: '0f6c2a8e-3d51-4b7a-9c2e-5a8d1e4f7b30',
          incarnation: '0f6c2a8e',
          token: 't',
        },
      ],
    ]),
    defaultDaemon: 'cloud',
  };

  expect(() => resolveDaemonRequest(params, registry)).toThrow(
    expect.objectContaining({ code, message }),
  );
});

test('it refuses a request whose ids point at two daemons', () => {
  const registry = {
    daemons: new Map([
      [
        'cloud',
        {
          name: 'cloud',
          address: { host: '100.64.0.2', port: 8415 },
          daemonID: '0f6c2a8e-3d51-4b7a-9c2e-5a8d1e4f7b30',
          incarnation: '0f6c2a8e',
          token: 't',
        },
      ],
      [
        'pc',
        {
          name: 'pc',
          address: { host: '100.64.0.3', port: 8415 },
          daemonID: '9a1b2c3d-0000-4000-8000-000000000001',
          incarnation: '9a1b2c3d',
          token: 't',
        },
      ],
    ]),
    defaultDaemon: 'cloud',
  };

  expect(() =>
    resolveDaemonRequest({ session: 'cloud.0f6c2a8e.s1', message: 'pc.9a1b2c3d.m-1' }, registry),
  ).toThrow(expect.objectContaining({ code: 'bad_args', message: "no message 'pc.9a1b2c3d.m-1'" }));
});
