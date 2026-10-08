import { expect, test } from 'bun:test';
import { buildAgentAdapters } from '../agents/build-agent-adapters';
import { parseConfig } from '../shared/config';
import { getRecord } from '../shared/get-record';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { waitFor } from '../test-utils/wait-for';

test('it accepts a hook line carrying the kind for a second codex entry', async () => {
  const daemon = await startTestDaemon({
    prefix: 'atc-daemon-hook-agent-',
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig({
          agents: {
            codex: { bin: 'sleep', args: ['30'] },
            'codex-fast': { kind: 'codex', bin: 'sleep', args: ['30'] },
          },
        }),
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
        parseConfig({
          agents: {
            codex: { bin: 'sleep', args: ['30'] },
            'codex-fast': { kind: 'codex', bin: 'sleep', args: ['30'] },
          },
        }),
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
        parseConfig({
          agents: {
            codex: { bin: 'sleep', args: ['30'] },
            claude: { bin: 'bash', args: ['-c', 'sleep 30'] },
          },
        }),
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
