// oxlint-disable zgeoff/test-beside-module -- tests run-tool.ts; GEO-433 moves it beside its module
import { expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { toAgentSessionID } from '@atc/core/to-agent-session-id';
import { ImpProvider } from '@atc/execution-imp/imp-provider';
import { createStubImpPort } from '@atc/execution-imp/testing/create-stub-imp-port';
import { LocalPTYProvider } from '@atc/execution-local/local-pty-provider';
import type { AgentAdapter } from '@atc/plugin-api/agent-adapter';
import { DaemonClient } from '@atc/protocol/client/daemon-client';
import { buildMockAgentAdapter } from '@atc/test-utils/build-mock-agent-adapter';
import { getRecord } from '@atc/test-utils/get-record';
import { registerTestCleanup } from '@atc/test-utils/register-test-cleanup';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { buildPrincipalCaller } from './build-principal-caller';
import { ReconnectingCaller } from './reconnecting-caller';
import { runTool } from './run-tool';

// A real daemon with `atc mcp`'s caller in front of it and two targets: the
// default `local` target, whose sessions run on this machine, and `box`, an
// imp target over a stub imp port. `planSpawn` records the options of each
// launch the agent plans, a resume id among them.
async function setupTest() {
  const planSpawn = mock<AgentAdapter['planSpawn']>(() => ({ bin: 'sleep', args: ['30'] }));

  const daemon = await startTestDaemon({
    prefix: 'atc-run-tool-adopt-',
    options: (paths) => ({
      adapter: buildMockAgentAdapter({ planSpawn }),
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        },
        {
          id: 'box',
          kind: 'imp',
          options: {},
          identity: 'imp:test',
          provider: new ImpProvider(
            createStubImpPort(),
            { guestDir: join(paths.dir, 'g') },
            { reconnectDelaysMs: [0, 0, 0], version: '1.0.0' },
          ),
        },
      ],

      // The daemon reads principals only at boot, so the remote client the
      // reach tests act as, ops, which may use box only, is set here.
      principals: new Map([['ops', ['box']]]),
    }),
  });

  const caller = new ReconnectingCaller(daemon.socketPath, daemon.build, (path) =>
    DaemonClient.open(path),
  );

  registerTestCleanup(() => caller.stop());

  return { caller, planSpawn, cwd: daemon.dir };
}

test('it starts a stopped local session again with its agent session resumed', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.caller.sendRequest('session.spawn', {
    cwd: ctx.cwd,
    target: 'local',
    resume: 'agent-session-1',
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await runTool(ctx.caller, 'atc_session_stop', { session: id }, { callerSessionID: null });

  ctx.planSpawn.mockClear();

  const adopted = await runTool(
    ctx.caller,
    'atc_session_adopt',
    { session: id },
    { callerSessionID: null },
  );

  expect(adopted.structured).toStrictEqual({ adopted: true });

  expect(ctx.planSpawn.mock.calls.map(([opts]) => opts.resume)).toStrictEqual([
    toAgentSessionID('agent-session-1'),
  ]);

  expect(ctx.caller.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [{ id, alive: true, kind: 'pty' }],
  });
});

test('it wakes the imp of a session that a stop put to sleep and starts the session on it', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.caller.sendRequest('session.spawn', {
    cwd: ctx.cwd,
    target: 'box',
    resume: 'agent-session-1',
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await runTool(ctx.caller, 'atc_session_stop', { session: id }, { callerSessionID: null });

  const slept = await ctx.caller.sendRequest('session.list');

  const adopted = await runTool(
    ctx.caller,
    'atc_session_adopt',
    { session: id },
    { callerSessionID: null },
  );

  expect(slept).toMatchObject({ sessions: [{ id, alive: false, lifecycle: { vm: 'asleep' } }] });
  expect(adopted.structured).toStrictEqual({ adopted: true });

  expect(ctx.caller.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [{ id, alive: true, lifecycle: { vm: 'awake', harness: 'running' } }],
  });
});

test('it refuses a remote client a stopped session on a target outside its reach and starts nothing', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.caller.sendRequest('session.spawn', {
    cwd: ctx.cwd,
    target: 'local',
    resume: 'agent-session-1',
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await runTool(ctx.caller, 'atc_session_stop', { session: id }, { callerSessionID: null });

  ctx.planSpawn.mockClear();

  const remote = buildPrincipalCaller(ctx.caller, { id: 'ops', name: 'ops-console' });
  const refused = runTool(remote, 'atc_session_adopt', { session: id }, { callerSessionID: null });

  await refused.catch(() => null);

  expect(refused).rejects.toMatchObject({ code: 'no_such_session' });
  expect(ctx.planSpawn.mock.calls).toStrictEqual([]);

  expect(ctx.caller.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [{ id, alive: false }],
  });
});

test('it lets a remote client wake a stopped session on a target in its reach', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.caller.sendRequest('session.spawn', {
    cwd: ctx.cwd,
    target: 'box',
    resume: 'agent-session-1',
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await runTool(ctx.caller, 'atc_session_stop', { session: id }, { callerSessionID: null });

  const remote = buildPrincipalCaller(ctx.caller, { id: 'ops', name: 'ops-console' });

  const adopted = await runTool(
    remote,
    'atc_session_adopt',
    { session: id },
    { callerSessionID: null },
  );

  expect(adopted.structured).toStrictEqual({ adopted: true });

  expect(ctx.caller.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [{ id, alive: true }],
  });
});

test('it starts a stopped pinned session again, since a pin guards only against a forget', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.caller.sendRequest('session.spawn', {
    cwd: ctx.cwd,
    target: 'local',
    resume: 'agent-session-1',
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await ctx.caller.sendRequest('session.update', { session: id, pinned: true });

  await runTool(ctx.caller, 'atc_session_stop', { session: id }, { callerSessionID: null });

  const adopted = await runTool(
    ctx.caller,
    'atc_session_adopt',
    { session: id },
    { callerSessionID: null },
  );

  expect(adopted.structured).toStrictEqual({ adopted: true });

  expect(ctx.caller.sendRequest('session.list')).resolves.toMatchObject({
    sessions: [{ id, alive: true, pinned: true }],
  });
});
