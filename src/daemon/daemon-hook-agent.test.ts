import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { buildAgentAdapters } from '../agents/build-agent-adapters';
import { DaemonClient } from '../client/daemon-client';
import { parseConfig } from '../shared/config';
import { isRecord } from '../shared/report';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { waitFor } from '../test-utils/wait-for';
import { startDaemon } from './daemon';

/**
 * A real daemon whose adapters come from an agents map, each entry running
 * `sleep` in place of its harness, with a client and a way to send the
 * daemon one hook line over its reporter socket.
 */
async function setupTest() {
  const tmp = setupTempDir('atc-daemon-hook-agent-');

  const config = parseConfig({
    agents: {
      codex: { bin: 'sleep', args: ['30'] },
      'codex-fast': { kind: 'codex', bin: 'sleep', args: ['30'] },
      claude: { bin: 'bash', args: ['-c', 'sleep 30'] },
    },
  });

  const reporterPath = join(tmp.dir, 'reporter.sock');
  const sockPath = join(tmp.dir, 'daemon.sock');

  const daemon = await startDaemon({
    socketPath: sockPath,
    reporterSocketPath: reporterPath,
    build: 'atc/test-build',
    adapters: buildAgentAdapters(config),
    dbPath: join(tmp.dir, 'state.db'),
    statusPath: join(tmp.dir, 'status.json'),
  });

  const client = await DaemonClient.open(sockPath);

  await client.sendHello('atc/test-build');

  return {
    client,
    async spawn(agent: string) {
      const spawned = await client.sendRequest('session.spawn', {
        cwd: '/tmp',
        agent,
        cols: 80,
        rows: 24,
      });

      const session = spawned['session'];

      if (!isRecord(session) || typeof session['id'] !== 'string') {
        throw new Error('no session in spawn answer');
      }

      return session['id'];
    },
    async sendHookLines(...lines: readonly Readonly<Record<string, unknown>>[]) {
      const closed = Promise.withResolvers<void>();

      await Bun.connect({
        unix: reporterPath,
        socket: {
          open(socket) {
            socket.write(lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
            socket.end();
          },
          close() {
            closed.resolve();
          },
          data() {},
          error() {},
        },
      });

      await closed.promise;
    },
    async [Symbol.asyncDispose]() {
      client.stop();

      await daemon.stop();

      tmp[Symbol.dispose]();
    },
  };
}

test('it accepts a hook line carrying the kind for a second codex entry', async () => {
  await using daemon = await setupTest();

  const id = await daemon.spawn('codex-fast');

  await daemon.sendHookLines({
    atcId: id,
    agent: 'codex',
    event: 'SessionStart',
    payload: { session_id: 'codex-sid-1' },
  });

  const resumed = await waitFor(async () => {
    const answer = await daemon.client.sendRequest('session.resumeCommand', { session: id });

    expect(answer['command']).toInclude('codex-sid-1');

    return answer;
  });

  expect(resumed).toStrictEqual({ command: "cd '/tmp' && codex resume codex-sid-1" });
});

test('it drops a hook line carrying the entry id for a codex entry', async () => {
  await using daemon = await setupTest();

  const id = await daemon.spawn('codex-fast');

  await daemon.sendHookLines(
    {
      atcId: id,
      agent: 'codex-fast',
      event: 'SessionStart',
      payload: { session_id: 'dropped-sid' },
    },
    { atcId: id, agent: 'codex', event: 'PermissionRequest', payload: { tool_name: 'sentinel' } },
  );

  await waitFor(async () => {
    const listed = await daemon.client.sendRequest('session.list');

    expect(JSON.stringify(listed)).toInclude('waiting for approval: sentinel');
  });

  const resumed = await daemon.client.sendRequest('session.resumeCommand', { session: id });

  expect(resumed).toStrictEqual({ command: "cd '/tmp' && codex resume" });
});

test('it drops a hook line from another agent at a claude session', async () => {
  await using daemon = await setupTest();

  const id = await daemon.spawn('claude');

  await daemon.sendHookLines(
    {
      atcId: id,
      agent: 'codex',
      event: 'SessionStart',
      payload: { session_id: 'nested-codex' },
    },
    { atcId: id, agent: 'claude', event: 'Notification', payload: { message: 'sentinel' } },
  );

  await waitFor(async () => {
    const listed = await daemon.client.sendRequest('session.list');

    expect(JSON.stringify(listed)).toInclude('sentinel');
  });

  const resumed = await daemon.client.sendRequest('session.resumeCommand', { session: id });

  expect(resumed['command']).not.toInclude('nested-codex');
});
