import { expect, test } from 'bun:test';
import { buildStubFleetCaller } from '@atc/fleet-api/test-utils/build-stub-fleet-caller';
import { buildStubFleetClient } from '@atc/fleet-api/test-utils/build-stub-fleet-client';
import { buildMockSessionDescriptor } from '@atc/protocol/test-utils/build-mock-session-descriptor';
import { toSessionID } from '@atcx/contract';
import { AtcError } from '@atcx/contract/light';
import { createTestFleetClient } from '../test-utils/create-test-fleet-client';
import { runTool } from './run-tool';

test('it sends stopOnly on a stop, which the router adds and the tool leaves out', async () => {
  const caller = buildStubFleetCaller({ answer: () => ({ stopped: true }) });

  await runTool(
    createTestFleetClient(caller),
    'atc_session_stop',
    { session: 's1' },
    { callerSessionID: null },
  );

  expect(caller.requests).toStrictEqual([
    { method: 'session.kill', params: { session: 's1', stopOnly: true } },
  ]);
});

test.each([
  ['without stop', {}, true],
  ['with stop', { stop: true }, false],
])('it sends the forget guards the router sets, %s', async (_case, args, refuseLive) => {
  const caller = buildStubFleetCaller({
    answer: () => ({ confirmToken: 't1', expiresAt: 1 }),
  });

  await runTool(
    createTestFleetClient(caller),
    'atc_session_forget',
    { session: 's1', ...args },
    { callerSessionID: null },
  );

  expect(caller.requests).toStrictEqual([
    {
      method: 'session.forget',
      params: { session: 's1', refusePinned: true, refuseLive },
    },
  ]);
});

test.each([
  ['session_pinned', 'session_pinned: the session is pinned'],
  ['session_live', 'session_live: the session is live'],
] as const)('it words a forget refused as %s in plain language', (code, text) => {
  const caller = buildStubFleetCaller({
    answer: () => {
      throw new AtcError(code, 'refused');
    },
  });

  const call = runTool(
    createTestFleetClient(caller),
    'atc_session_forget',
    { session: 's1' },
    { callerSessionID: null },
  );

  expect(call).rejects.toThrow(text);
});

test('it mints a key for a spawn that holds none', async () => {
  const caller = buildStubFleetCaller({
    answer: () => ({ session: buildMockSessionDescriptor({ id: toSessionID('s-1') }) }),
  });

  await runTool(
    createTestFleetClient(caller),
    'atc_session_spawn',
    { cwd: '/work' },
    { callerSessionID: null },
  );

  expect(caller.requests[0]?.params?.['idempotencyKey']).toMatch(/^[0-9a-f-]{36}$/u);
});

test('it mints a key for a message that holds none', async () => {
  const caller = buildStubFleetCaller({ answer: () => ({ message: 'm1', status: 'queued' }) });

  await runTool(
    createTestFleetClient(caller),
    'atc_message_send',
    { session: 's1', text: 'hi' },
    { callerSessionID: null },
  );

  expect(caller.requests[0]?.params?.['idempotencyKey']).toMatch(/^[0-9a-f-]{36}$/u);
});

test('it keeps the key a spawn call gives', async () => {
  const caller = buildStubFleetCaller({
    answer: () => ({ session: buildMockSessionDescriptor({ id: toSessionID('s-1') }) }),
  });

  await runTool(
    createTestFleetClient(caller),
    'atc_session_spawn',
    { cwd: '/work', idempotencyKey: 'mine' },
    { callerSessionID: null },
  );

  expect(caller.requests[0]?.params?.['idempotencyKey']).toBe('mine');
});

test('it falls back to a top-level spawn when a minted-key nested spawn names a gone session', async () => {
  const descriptor = buildMockSessionDescriptor({ id: toSessionID('s-1') });

  const caller = buildStubFleetCaller({
    answer: (request) => {
      if (request.params?.['parent'] !== undefined) {
        throw new AtcError('no_such_session', 'no session gone');
      }

      return { session: descriptor };
    },
  });

  await runTool(
    createTestFleetClient(caller),
    'atc_session_spawn',
    { cwd: '/work' },
    { callerSessionID: 'gone' },
  );

  expect(caller.requests.map((request) => request.params?.['parent'])).toStrictEqual([
    'gone',
    undefined,
  ]);

  expect(caller.requests[1]?.params?.['idempotencyKey']).toMatch(/^top-level:[0-9a-f]{64}$/u);
});

test('it spawns nothing top-level when the refused nested spawn names an effect', () => {
  const caller = buildStubFleetCaller({
    answer: () => {
      throw new AtcError('no_such_session', 'no session gone', { effectRef: 's-ran' });
    },
  });

  const call = runTool(
    createTestFleetClient(caller),
    'atc_session_spawn',
    { cwd: '/work' },
    { callerSessionID: 'gone' },
  );

  expect(call).rejects.toMatchObject({ code: 'no_such_session', data: { effectRef: 's-ran' } });
  expect(caller.requests).toHaveLength(1);
});

test('it fails the daemons tool on a local router as an unknown method, which serves no daemons.list', () => {
  const caller = buildStubFleetCaller();

  const call = runTool(
    createTestFleetClient(caller),
    'atc_daemons_list',
    {},
    { callerSessionID: null },
  );

  expect(call).rejects.toMatchObject({
    code: 'unknown_method',
    message: "unknown method 'daemons.list'",
  });

  expect(caller.requests).toStrictEqual([]);
});

test('it gives a local client no daemon name for a recent-directories call', async () => {
  const stub = buildStubFleetClient();

  await runTool(
    stub.client,
    'atc_recent_dirs_list',
    { daemon: 'build-box' },
    { callerSessionID: null },
  );

  expect(stub.calls).toStrictEqual([{ method: 'dirs.list', input: {} }]);
});

test('it gives a local client no daemon name for a spawn', async () => {
  const stub = buildStubFleetClient();

  await runTool(
    stub.client,
    'atc_session_spawn',
    { cwd: '/work', daemon: 'build-box', idempotencyKey: 'k-1' },
    { callerSessionID: null },
  );

  expect(stub.calls).toStrictEqual([
    { method: 'session.spawn', input: { cwd: '/work', idempotencyKey: 'k-1' } },
  ]);
});

test('it gives a gateway client the daemon name of a recent-directories call', async () => {
  const stub = buildStubFleetClient({ hasDaemons: true });

  await runTool(
    stub.client,
    'atc_recent_dirs_list',
    { daemon: 'build-box' },
    { callerSessionID: null },
  );

  expect(stub.calls).toStrictEqual([{ method: 'dirs.list', input: { daemon: 'build-box' } }]);
});

test('it answers the daemons tool without the gateway build, the contract and the features of each daemon', async () => {
  const caller = buildStubFleetCaller({
    features: ['fleet.daemons'],
    answer: () => ({
      daemons: [
        {
          name: 'build-box',
          state: 'up',
          build: 'atc 7.25.1',
          daemonID: 'd-build-box',
          features: ['session.host'],
        },
      ],
      defaultDaemon: 'build-box',
      build: 'atc-gateway 1.9.0',
      contract: '7.26.0',
    }),
  });

  const result = await runTool(
    createTestFleetClient(caller, { id: 'service:ci', name: 'ci' }),
    'atc_daemons_list',
    {},
    { callerSessionID: null },
  );

  expect(result.structured).toStrictEqual({
    daemons: [{ name: 'build-box', state: 'up', build: 'atc 7.25.1', daemonID: 'd-build-box' }],
    defaultDaemon: 'build-box',
  });
});
