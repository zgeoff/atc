import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemonProcess } from '@atc/lifecycle/testing';
import type { DaemonEvent } from '@atc/protocol';
import {
  createStubClaude,
  createStubComposer,
  getRecord,
  getString,
  resolveATCCommand,
  runATC,
  setupTempDir,
  waitFor,
  waitForEvent,
} from '@atc/test-utils';

// The stand-in Claude opens a message tap through the real atc command, and
// the nested harness reports through the real `atc hook-report`, so this case
// runs the daemon and both commands as processes.
function setupTest() {
  const temporaryDirectory = setupTempDir('atc-e2e-hooks-');
  const atc = resolveATCCommand();
  const composer = createStubComposer(temporaryDirectory.path);
  const configDir = join(temporaryDirectory.path, '.config', 'atc');

  mkdirSync(configDir, { recursive: true });

  return {
    home: temporaryDirectory.path,
    atc,
    configPath: join(configDir, 'config.json'),
    claude: createStubClaude(temporaryDirectory.path, { atc, composer }),
  };
}

test('it keeps a nested codex harness from rebinding or answering for the claude session it runs in', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.configPath, JSON.stringify({ agents: { claude: { bin: ctx.claude } } }));

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  const events: DaemonEvent[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  writeFileSync(join(ctx.home, 'fake-claude-tap'), '');

  const spawned = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(spawned, 'session'), 'id');

  await waitForEvent(events, { ev: 'SessionState', session: { state: 'needs_you' } });

  const sent = await client.sendRequest('session.message', {
    session: id,
    text: 'ping from test',
  });

  const messageID = getString(sent, 'message');

  await waitForEvent(events, { ev: 'SessionMessage', status: 'delivered' });

  const childStart = await runATC({
    command: ctx.atc,
    args: ['hook-report', '--agent', 'codex'],
    home: ctx.home,
    env: { ATC_SESSION_ID: id, ATC_SOCKET: daemon.reporterSocketPath },
    stdin: JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: 'nested-codex-1',
      transcript_path: `${ctx.home}/nested-rollout.jsonl`,
      source: 'startup',
    }),
  });

  const childStop = await runATC({
    command: ctx.atc,
    args: ['hook-report', '--agent', 'codex'],
    home: ctx.home,
    env: { ATC_SESSION_ID: id, ATC_SOCKET: daemon.reporterSocketPath },
    stdin: JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 'nested-codex-1',
      last_assistant_message: 'nested codex output',
    }),
  });

  await waitFor(() => {
    expect(daemon.readStderr()).toIncludeMultiple([
      `atc hook event=dropped session=${id} agent=codex hook=SessionStart`,
      `atc hook event=dropped session=${id} agent=codex hook=Stop`,
    ]);
  });

  const record = await client.sendRequest('session.get', { session: id });
  const message = await client.sendRequest('message.get', { message: messageID });

  expect(childStart.exitCode).toBe(0);
  expect(childStop.exitCode).toBe(0);

  expect(record).toMatchObject({
    session: { agentSessionID: 'fake-1', state: 'needs_you', lastMsg: 'needs permission' },
    result: null,
  });

  expect(message).toMatchObject({ session: id, status: 'delivered' });
  expect(message).not.toContainKey('answer');
});
