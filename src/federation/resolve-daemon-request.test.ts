import { expect, test } from 'bun:test';
import { buildMockRegistryDaemon } from '../test-utils/build-mock-registry-daemon';
import { resolveDaemonRequest } from './resolve-daemon-request';

test('it routes a request by its session id and hands the daemon its own id', () => {
  const cloud = buildMockRegistryDaemon({ name: 'cloud', incarnation: '0f6c2a8e' });

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
  [{ session: 'cloud.11111111.s1' }, 'no_such_session', "no session 'cloud.11111111.s1'"],
  [{ session: 'pc.0f6c2a8e.s1' }, 'no_such_session', "no session 'pc.0f6c2a8e.s1'"],
  [{ session: 's1' }, 'no_such_session', "no session 's1'"],
  [{ parent: 's1' }, 'no_such_session', "no session 's1'"],
  [{ message: 'm-1' }, 'bad_args', "no message 'm-1'"],
])('it refuses %p with %s as a daemon refuses an id it never held', (params, code, message) => {
  const registry = {
    daemons: new Map([
      ['cloud', buildMockRegistryDaemon({ name: 'cloud', incarnation: '0f6c2a8e' })],
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
      ['cloud', buildMockRegistryDaemon({ name: 'cloud', incarnation: '0f6c2a8e' })],
      ['pc', buildMockRegistryDaemon({ name: 'pc', incarnation: '9a1b2c3d' })],
    ]),
    defaultDaemon: 'cloud',
  };

  expect(() =>
    resolveDaemonRequest({ session: 'cloud.0f6c2a8e.s1', message: 'pc.9a1b2c3d.m-1' }, registry),
  ).toThrow(expect.objectContaining({ code: 'bad_args', message: "no message 'pc.9a1b2c3d.m-1'" }));
});

test('it routes note.get by its note handle and hands the daemon its own cursor', () => {
  const pc = buildMockRegistryDaemon({ name: 'pc', incarnation: '9a1b2c3d' });

  const resolved = resolveDaemonRequest(
    { note: 'pc.9a1b2c3d.eyJrIjoiZXYiLCJpIjo3fQ' },
    { daemons: new Map([['pc', pc]]), defaultDaemon: 'pc' },
  );

  expect(resolved).toStrictEqual({
    daemon: pc,
    params: { note: 'eyJrIjoiZXYiLCJpIjo3fQ' },
    requestIDs: new Map([['eyJrIjoiZXYiLCJpIjo3fQ', 'pc.9a1b2c3d.eyJrIjoiZXYiLCJpIjo3fQ']]),
  });
});

test('it refuses a note handle with a stale incarnation as an unknown note', () => {
  const pc = buildMockRegistryDaemon({ name: 'pc', incarnation: '9a1b2c3d' });

  expect(() =>
    resolveDaemonRequest(
      { note: 'pc.11111111.eyJrIjoiZXYiLCJpIjo3fQ' },
      { daemons: new Map([['pc', pc]]), defaultDaemon: 'pc' },
    ),
  ).toThrow(
    expect.objectContaining({
      code: 'bad_args',
      message: "no note 'pc.11111111.eyJrIjoiZXYiLCJpIjo3fQ'",
    }),
  );
});
