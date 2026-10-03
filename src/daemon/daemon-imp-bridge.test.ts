import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FixtureImpPort } from '../../test/fixture-imp-port';
import { setupTempDir } from '../../test/setup-temp-dir';
import { waitFor } from '../../test/wait-for';
import { ClaudeAdapter } from '../agents/claude-adapter';
import { DaemonClient } from '../client/daemon-client';
import { openBridgeSocket } from '../protocol/open-bridge-socket';
import type { EventMsg } from '../protocol/protocol';
import { sendBridgeRequest } from '../protocol/send-bridge-request';
import { getRecord } from '../shared/get-record';
import { startDaemon } from './daemon';
import { ImpProvider } from './imp-provider';

// The atc CLI from this source tree, which the fake guest atc runs.
const CLI_PATH = join(import.meta.dir, '..', 'cli.ts');

// A real daemon whose one target `box` runs Claude sessions on the imp
// provider over a fixture imp port, with the guest folder under a temp
// directory and the guest atc running this source tree. The fake claude
// reads one command per line: `start` reports a SessionStart, `tap` runs
// the guest tap in the background into `tap.log`, `answer <id>` reports
// that message answered, and `note <text>` reports a note.
async function setupTest() {
  const tmp = setupTempDir('atc-imp-bridge-');
  const sockPath = join(tmp.dir, 'daemon.sock');
  const fakeClaude = join(tmp.dir, 'fake-claude');
  const fakeATC = join(tmp.dir, 'fake-atc');
  const guestDir = join(tmp.dir, 'g');
  const tapLog = join(tmp.dir, 'tap.log');

  const port = new FixtureImpPort();

  writeFileSync(tapLog, '');

  writeFileSync(fakeATC, `#!/bin/sh\nexec "${process.execPath}" "${CLI_PATH}" "$@"\n`, {
    mode: 0o755,
  });

  writeFileSync(
    fakeClaude,
    `#!/usr/bin/env bash
echo "UP:$$"
while read -r line; do
  case "$line" in
    start) echo '{"hook_event_name":"SessionStart","session_id":"agent-remote-1","transcript_path":"/guest/only/transcript.jsonl"}' | "${fakeATC}" hook-report ;;
    tap) "${fakeATC}" tap --session "$ATC_SESSION_ID" >> "${tapLog}" 2>&1 & ;;
    answer*) printf 'the answer' | "${fakeATC}" report answered --messages "\${line#answer }" ;;
    note*) printf '%s' "\${line#note }" | "${fakeATC}" report note --label progress ;;
  esac
  echo "GOT:$line"
done
`,
    { mode: 0o755 },
  );

  const daemon = await startDaemon({
    socketPath: sockPath,
    reporterSocketPath: join(tmp.dir, 'reporter.sock'),
    build: 'atc/test-build',
    adapter: new ClaudeAdapter({
      claudeBin: fakeClaude,
      claudeArgs: [],
      grokBin: 'grok',
      grokArgs: [],
      codexBin: 'codex',
      codexArgs: [],
      dirs: { roots: [] },
      workspaces: { githubOwner: null, sources: null },
      gateways: [],
      hooks: {},
      leader: { code: 0, label: '^Space' },
      targets: [{ id: 'box', provider: 'imp', options: {} }],
      defaultTarget: 'box',
      targetErrors: [],
      principals: new Map(),
      principalErrors: [],
    }),
    dbPath: join(tmp.dir, 'state.db'),
    statusPath: join(tmp.dir, 'status.json'),
    targets: [
      {
        id: 'box',
        kind: 'imp',
        options: {},
        identity: 'imp:test',
        provider: new ImpProvider(
          port,
          { guestDir, guestATC: fakeATC },
          { reconnectDelaysMs: [0, 0, 0], atcBinary: null },
        ),
      },
    ],
    defaultTarget: 'box',
  });

  const client = await DaemonClient.open(sockPath);

  const events: EventMsg[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test-build');

  return {
    client,
    port,
    events,
    dir: tmp.dir,
    guestDir,
    tapLog,
    async [Symbol.asyncDispose]() {
      client.stop();

      await daemon.stop();

      port[Symbol.dispose]();
      tmp[Symbol.dispose]();
    },
  };
}

test("it delivers a message to a remote session's tap and records the answer the session reports", async () => {
  await using daemon = await setupTest();

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await daemon.client.sendRequest('session.input', { session: id, d: 'tap\r' });

  const sent = await daemon.client.sendRequest('session.message', { session: id, text: 'hello' });

  const messageID = String(sent['message']);

  await waitFor(() => {
    expect(readFileSync(daemon.tapLog, 'utf8')).toInclude(`"id":"${messageID}"`);
  });

  await waitFor(async () => {
    const read = await daemon.client.sendRequest('message.get', { message: messageID });

    expect(read).toMatchObject({ status: 'delivered' });
  });

  await daemon.client.sendRequest('session.input', { session: id, d: `answer ${messageID}\r` });

  await waitFor(async () => {
    const read = await daemon.client.sendRequest('message.get', { message: messageID });

    expect(read).toMatchObject({ status: 'answered', answer: 'the answer' });
  });
});

test("it answers a status read on a remote session's bridge with that session's own state", async () => {
  await using daemon = await setupTest();

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = String(getRecord(spawned, 'session')['id']);

  const socketName = id
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/g, '')
    .slice(0, 16);

  const status = await sendBridgeRequest(
    join(daemon.guestDir, 'run', `${socketName}.sock`),
    'status.read',
    {},
    2000,
  );

  expect(status).toStrictEqual({
    id: expect.toBeString(),
    ok: true,
    state: 'running',
    lastMsg: 'started',
  });
});

test('it answers an op the bridge does not offer with forbidden and closes the connection', async () => {
  await using daemon = await setupTest();

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = String(getRecord(spawned, 'session')['id']);

  const socketName = id
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/g, '')
    .slice(0, 16);

  const answers: Readonly<Record<string, unknown>>[] = [];

  const socket = await openBridgeSocket(
    join(daemon.guestDir, 'run', `${socketName}.sock`),
    (line) => {
      answers.push(line);
    },
  );

  socket.writeLine({ v: 1, id: 'list', op: 'session.list' });

  await socket.closed;

  expect(answers).toStrictEqual([{ id: 'list', ok: false, code: 'forbidden' }]);
});

test('it delivers a message sent after a sleep and a wake to the tap that ran before, and each message once', async () => {
  await using daemon = await setupTest();

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await daemon.client.sendRequest('session.input', { session: id, d: 'start\r' });
  await daemon.client.sendRequest('session.input', { session: id, d: 'tap\r' });

  const before = await daemon.client.sendRequest('session.message', {
    session: id,
    text: 'before',
  });

  await waitFor(() => {
    expect(readFileSync(daemon.tapLog, 'utf8')).toInclude(`"id":"${String(before['message'])}"`);
  });

  await daemon.client.sendRequest('session.kill', { session: id });
  await daemon.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  const after = await daemon.client.sendRequest('session.message', { session: id, text: 'after' });

  await waitFor(
    () => {
      expect(readFileSync(daemon.tapLog, 'utf8')).toInclude(`"id":"${String(after['message'])}"`);
    },
    { timeoutMs: 15_000 },
  );

  const printed = readFileSync(daemon.tapLog, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line): unknown => JSON.parse(line));

  expect(printed).toStrictEqual([
    {
      id: before['message'],
      from: expect.toBeString(),
      text: 'before',
      sentAt: expect.toBeNumber(),
    },
    { id: after['message'], from: expect.toBeString(), text: 'after', sentAt: expect.toBeNumber() },
  ]);
});

test('it delivers a message and a report held back while the bridge was unreachable once each after it reconnects', async () => {
  await using daemon = await setupTest();

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await daemon.client.sendRequest('session.attach', { session: id, cols: 80, rows: 24 });
  await daemon.client.sendRequest('session.input', { session: id, d: 'tap\r' });

  const first = await daemon.client.sendRequest('session.message', { session: id, text: 'first' });

  await waitFor(() => {
    expect(readFileSync(daemon.tapLog, 'utf8')).toInclude(`"id":"${String(first['message'])}"`);
  });

  daemon.port.startRelayRefusal();
  daemon.port.stopRelays();

  const held = await daemon.client.sendRequest('session.message', { session: id, text: 'held' });

  await daemon.client.sendRequest('session.input', { session: id, d: 'note while away\r' });

  await waitFor(() => {
    expect(
      daemon.events
        .filter((event) => event.ev === 'SessionOutput')
        .map((event) => String(event['d']))
        .join(''),
    ).toInclude('GOT:note while away');
  });

  daemon.port.stopRelayRefusal();

  await waitFor(
    () => {
      expect(readFileSync(daemon.tapLog, 'utf8')).toInclude(`"id":"${String(held['message'])}"`);
      expect(daemon.events).toPartiallyContain({ ev: 'SessionReport', text: 'while away' });
    },
    { timeoutMs: 15_000 },
  );

  const printed = readFileSync(daemon.tapLog, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line): unknown => JSON.parse(line));

  expect({
    printed,
    reports: daemon.events.filter((event) => event.ev === 'SessionReport'),
  }).toMatchObject({
    printed: [{ id: first['message'] }, { id: held['message'] }],
    reports: [{ text: 'while away' }],
  });
});

test('it prints a message whose ack was lost once, and acks it again when the tap reconnects', async () => {
  await using daemon = await setupTest();

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await daemon.client.sendRequest('session.input', { session: id, d: 'tap\r' });

  const ready = await daemon.client.sendRequest('session.message', { session: id, text: 'ready' });

  await waitFor(async () => {
    const read = await daemon.client.sendRequest('message.get', { message: ready['message'] });

    expect(read).toMatchObject({ status: 'delivered' });
  });

  daemon.port.startGuestByteDrop();

  const lost = await daemon.client.sendRequest('session.message', {
    session: id,
    text: 'lost ack',
  });

  await waitFor(() => {
    expect(readFileSync(daemon.tapLog, 'utf8')).toInclude(`"id":"${String(lost['message'])}"`);
  });

  const unacked = await daemon.client.sendRequest('message.get', { message: lost['message'] });

  daemon.port.stopGuestByteDrop();
  daemon.port.stopRelays();

  await waitFor(
    async () => {
      const read = await daemon.client.sendRequest('message.get', { message: lost['message'] });

      expect(read).toMatchObject({ status: 'delivered' });
    },
    { timeoutMs: 15_000 },
  );

  const printed = readFileSync(daemon.tapLog, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line): unknown => JSON.parse(line));

  expect({ unacked, printed }).toMatchObject({
    unacked: { status: 'accepted' },
    printed: [{ id: ready['message'] }, { id: lost['message'] }],
  });
});
