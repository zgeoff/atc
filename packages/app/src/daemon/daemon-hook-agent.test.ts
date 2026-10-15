// oxlint-disable zgeoff/test-beside-module -- a daemon.ts topic test, moved by the daemon split (GEO-401)
import { expect, test } from 'bun:test';
import { parseConfig } from '@atc/config';
import { buildMockAgentAdapter, buildMockHostServices, getRecord, waitFor } from '@atc/test-utils';
import { buildAgentAdapters } from '../agents/build-agent-adapters';
import { SHIPPED_HARNESS_PLUGINS } from '../plugins/shipped-harness-plugins';
import { startTestDaemon } from '../test-utils/start-test-daemon';

test("it passes each session's hook state back for that session alone, starting each at none", async () => {
  const seen: { readonly session: unknown; readonly prev: unknown }[] = [];

  const daemon = await startTestDaemon({
    prefix: 'atc-daemon-hook-agent-',
    options: () => ({
      // A harness whose state for a session is the hook events it has read
      // for that session, in order.
      adapter: buildMockAgentAdapter({
        planHookEvents: (event, prev) => {
          seen.push({ session: event.atcId, prev });

          const read: readonly unknown[] = Array.isArray(prev) ? prev : [];

          return {
            events: [{ kind: 'heartbeat' }],
            next: [...read, event.event],
          };
        },
      }),
    }),
  });

  const first = await daemon.client.sendRequest('session.spawn', { cwd: daemon.dir, name: 'a' });
  const second = await daemon.client.sendRequest('session.spawn', { cwd: daemon.dir, name: 'b' });

  const a = getRecord(first, 'session')['id'];
  const b = getRecord(second, 'session')['id'];

  await daemon.sendHookLines(
    { atcId: a, event: 'SessionStart', payload: {} },
    { atcId: b, event: 'SessionStart', payload: {} },
    { atcId: a, event: 'UserPromptSubmit', payload: {} },
    { atcId: b, event: 'Stop', payload: {} },
    { atcId: a, event: 'Stop', payload: {} },
  );

  await waitFor(() => {
    expect(seen).toHaveLength(5);
  });

  expect(seen).toStrictEqual([
    { session: a, prev: undefined },
    { session: b, prev: undefined },
    { session: a, prev: ['SessionStart'] },
    { session: b, prev: ['SessionStart'] },
    { session: a, prev: ['SessionStart', 'UserPromptSubmit'] },
  ]);
});

test('it accepts a hook line carrying the kind for a second codex entry', async () => {
  const daemon = await startTestDaemon({
    prefix: 'atc-daemon-hook-agent-',
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig(SHIPPED_HARNESS_PLUGINS, {
          agents: {
            codex: { bin: 'sleep', args: ['30'] },
            'codex-fast': { kind: 'codex', bin: 'sleep', args: ['30'] },
          },
        }),
        buildMockHostServices(),
      ),
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    agent: 'codex-fast',
    cols: 80,
    rows: 24,
  });

  const sessionID = getRecord(spawned, 'session')['id'];

  await daemon.sendHookLines({
    atcId: sessionID,
    agent: 'codex',
    event: 'SessionStart',
    payload: { session_id: 'codex-sid-1' },
  });

  const resumed = await waitFor(async () => {
    const answer = await daemon.client.sendRequest('session.resumeCommand', {
      session: sessionID,
    });

    expect(answer['command']).toInclude('codex-sid-1');

    return answer;
  });

  expect(resumed).toStrictEqual({ command: `cd '${daemon.dir}' && codex resume codex-sid-1` });
});

test('it drops a hook line carrying the entry id for a codex entry', async () => {
  const daemon = await startTestDaemon({
    prefix: 'atc-daemon-hook-agent-',
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig(SHIPPED_HARNESS_PLUGINS, {
          agents: {
            codex: { bin: 'sleep', args: ['30'] },
            'codex-fast': { kind: 'codex', bin: 'sleep', args: ['30'] },
          },
        }),
        buildMockHostServices(),
      ),
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    agent: 'codex-fast',
    cols: 80,
    rows: 24,
  });

  const sessionID = getRecord(spawned, 'session')['id'];

  await daemon.sendHookLines(
    {
      atcId: sessionID,
      agent: 'codex-fast',
      event: 'SessionStart',
      payload: { session_id: 'dropped-sid' },
    },
    {
      atcId: sessionID,
      agent: 'codex',
      event: 'PermissionRequest',
      payload: { tool_name: 'sentinel' },
    },
  );

  await waitFor(async () => {
    const listed = await daemon.client.sendRequest('session.list');

    expect(JSON.stringify(listed)).toInclude('waiting for approval: sentinel');
  });

  const resumed = await daemon.client.sendRequest('session.resumeCommand', {
    session: sessionID,
  });

  expect(resumed).toStrictEqual({ command: `cd '${daemon.dir}' && codex resume` });
});

test('it drops a hook line from another agent at a claude session', async () => {
  const daemon = await startTestDaemon({
    prefix: 'atc-daemon-hook-agent-',
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig(SHIPPED_HARNESS_PLUGINS, {
          agents: {
            codex: { bin: 'sleep', args: ['30'] },
            claude: { bin: 'bash', args: ['-c', 'sleep 30'] },
          },
        }),
        buildMockHostServices(),
      ),
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    agent: 'claude',
    cols: 80,
    rows: 24,
  });

  const sessionID = getRecord(spawned, 'session')['id'];

  await daemon.sendHookLines(
    {
      atcId: sessionID,
      agent: 'codex',
      event: 'SessionStart',
      payload: { session_id: 'nested-codex' },
    },
    { atcId: sessionID, agent: 'claude', event: 'Notification', payload: { message: 'sentinel' } },
  );

  await waitFor(async () => {
    const listed = await daemon.client.sendRequest('session.list');

    expect(JSON.stringify(listed)).toInclude('sentinel');
  });

  const resumed = await daemon.client.sendRequest('session.resumeCommand', {
    session: sessionID,
  });

  expect(resumed).toStrictEqual({ command: `cd '${daemon.dir}' && bash --resume` });
});
