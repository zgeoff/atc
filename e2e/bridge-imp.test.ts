import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig } from '@atc/config';
import { ImpProvider } from '@atc/execution-imp';
import { createStubImpPort } from '@atc/execution-imp/testing';
import { ClaudeAdapter } from '@atc/harness-claude';
import { openBridgeSocket, sendBridgeRequest } from '@atc/protocol/session';
import {
  buildMockHostServices,
  createStubGuestCLIs,
  getAgentEntry,
  getRecord,
  registerTestCleanup,
  setupTempDir,
  waitFor,
} from '@atc/test-utils';
import { buildHostServices } from '../packages/app/src/build-host-services';
import { SHIPPED_HARNESS_PLUGINS } from '../packages/app/src/plugins/shipped-harness-plugins';
import { startTestDaemon } from '../packages/app/src/test-utils/start-test-daemon';

// A real daemon whose one target `box`, its default, runs Claude sessions
// on the imp provider over a stub imp port, with the guest folder under
// a temp directory, the stub guest atc running this source tree, and the
// stub claude as Claude's binary.
async function setupTest() {
  const tmp = setupTempDir('atc-imp-bridge-');
  const clis = createStubGuestCLIs(join(tmp.dir, 'bin'));
  const guestDir = join(tmp.dir, 'g');
  const port = createStubImpPort();
  const config = parseConfig(SHIPPED_HARNESS_PLUGINS, { agents: { claude: { bin: clis.claude } } });

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-bridge-daemon-',
    options: () => ({
      adapter: new ClaudeAdapter(getAgentEntry(config, 'claude'), config, buildMockHostServices()),
      targets: [
        {
          id: 'box',
          kind: 'imp',
          options: {},
          identity: 'imp:test',
          provider: new ImpProvider(
            port,
            { guestDir, guestATC: clis.atc },
            {
              reconnectDelaysMs: [0, 0, 0],
              atcBinary: null,
              version: buildHostServices().version,
            },
          ),
        },
      ],
      defaultTarget: 'box',
    }),
  });

  return { daemon, port, dir: tmp.dir, guestDir };
}

test("it delivers a message to a remote session's tap", async () => {
  const ctx = await setupTest();

  const tapLog = join(ctx.dir, 'tap.log');

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await ctx.daemon.client.sendRequest('session.input', { session: id, d: `tap ${tapLog}\r` });

  const sent = await ctx.daemon.client.sendRequest('session.message', {
    session: id,
    text: 'hello',
  });

  await waitFor(async () => {
    const read = await ctx.daemon.client.sendRequest('message.get', { message: sent['message'] });

    expect(readFileSync(tapLog, 'utf8')).toInclude(`"id":"${String(sent['message'])}"`);
    expect(read).toMatchObject({ status: 'delivered' });
  });
});

test('it records the answer a remote session reports to a message its tap took', async () => {
  const ctx = await setupTest();

  const tapLog = join(ctx.dir, 'tap.log');

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await ctx.daemon.client.sendRequest('session.input', { session: id, d: `tap ${tapLog}\r` });

  const sent = await ctx.daemon.client.sendRequest('session.message', {
    session: id,
    text: 'hello',
  });

  const messageID = String(sent['message']);

  await waitFor(async () => {
    const read = await ctx.daemon.client.sendRequest('message.get', { message: messageID });

    expect(read).toMatchObject({ status: 'delivered' });
  });

  await ctx.daemon.client.sendRequest('session.input', {
    session: id,
    d: `answer ${messageID} the answer\r`,
  });

  await waitFor(async () => {
    const read = await ctx.daemon.client.sendRequest('message.get', { message: messageID });

    expect(read).toMatchObject({ status: 'answered', answer: 'the answer' });
  });
});

test("it answers a status read on a remote session's bridge with that session's own state", async () => {
  const ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = String(getRecord(spawned, 'session')['id']);

  // The bridge socket is named for the session id, lowercased, with only
  // letters and digits kept, cut to 16 characters.
  const socketName = id
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/g, '')
    .slice(0, 16);

  const status = await sendBridgeRequest(
    join(ctx.guestDir, 'run', `${socketName}.sock`),
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
  const ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = String(getRecord(spawned, 'session')['id']);

  // The bridge socket is named for the session id, lowercased, with only
  // letters and digits kept, cut to 16 characters.
  const socketName = id
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/g, '')
    .slice(0, 16);

  const answers: Readonly<Record<string, unknown>>[] = [];

  const socket = await openBridgeSocket(join(ctx.guestDir, 'run', `${socketName}.sock`), (line) => {
    answers.push(line);
  });

  registerTestCleanup(() => {
    socket.end();
  });

  socket.writeLine({ v: 1, id: 'list', op: 'session.list' });

  await socket.closed;

  expect(answers).toStrictEqual([{ id: 'list', ok: false, code: 'forbidden' }]);
});

test('it delivers a message sent after a sleep and a wake to the tap that ran before, and each message once', async () => {
  const ctx = await setupTest();

  const tapLog = join(ctx.dir, 'tap.log');

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await ctx.daemon.client.sendRequest('session.input', {
    session: id,
    d: 'start agent-remote-1\r',
  });

  await ctx.daemon.client.sendRequest('session.input', { session: id, d: `tap ${tapLog}\r` });

  const before = await ctx.daemon.client.sendRequest('session.message', {
    session: id,
    text: 'before',
  });

  await waitFor(() => {
    expect(readFileSync(tapLog, 'utf8')).toInclude(`"id":"${String(before['message'])}"`);
  });

  await ctx.daemon.client.sendRequest('session.kill', { session: id });
  await ctx.daemon.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  const after = await ctx.daemon.client.sendRequest('session.message', {
    session: id,
    text: 'after',
  });

  await waitFor(() => {
    const printed = readFileSync(tapLog, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line): unknown => JSON.parse(line));

    expect(printed).toStrictEqual([
      {
        id: before['message'],
        from: 'owner',
        sender: { kind: 'owner', name: 'owner' },
        text: 'before',
        sentAt: expect.toBeNumber(),
      },
      {
        id: after['message'],
        from: 'owner',
        sender: { kind: 'owner', name: 'owner' },
        text: 'after',
        sentAt: expect.toBeNumber(),
      },
    ]);
  });
});

test('it delivers a message and a note held back while the bridge was unreachable once each after it reconnects', async () => {
  const ctx = await setupTest();

  const tapLog = join(ctx.dir, 'tap.log');

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await ctx.daemon.client.sendRequest('session.attach', { session: id, cols: 80, rows: 24 });
  await ctx.daemon.client.sendRequest('session.input', { session: id, d: `tap ${tapLog}\r` });

  const first = await ctx.daemon.client.sendRequest('session.message', {
    session: id,
    text: 'first',
  });

  await waitFor(() => {
    expect(readFileSync(tapLog, 'utf8')).toInclude(`"id":"${String(first['message'])}"`);
  });

  ctx.port.startRelayRefusal();
  ctx.port.stopRelays();

  const held = await ctx.daemon.client.sendRequest('session.message', {
    session: id,
    text: 'held',
  });

  await ctx.daemon.client.sendRequest('session.input', { session: id, d: 'note while away\r' });

  await waitFor(() => {
    expect(
      ctx.daemon.events
        .filter((event) => event.ev === 'SessionOutput')
        .map((event) => String(event['d']))
        .join(''),
    ).toInclude('GOT:note while away');
  });

  const heldBefore = await ctx.daemon.client.sendRequest('message.get', {
    message: held['message'],
  });

  ctx.port.stopRelayRefusal();

  await waitFor(() => {
    const printed = readFileSync(tapLog, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line): unknown => JSON.parse(line));

    expect(printed).toMatchObject([{ id: first['message'] }, { id: held['message'] }]);

    expect(ctx.daemon.events.filter((event) => event.ev === 'SessionNote')).toMatchObject([
      { text: 'while away' },
    ]);
  });

  expect(heldBefore['status']).toBe('queued');
});

test('it prints a message whose ack was lost once, and acks it again when the tap reconnects', async () => {
  const ctx = await setupTest();

  const tapLog = join(ctx.dir, 'tap.log');

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await ctx.daemon.client.sendRequest('session.input', { session: id, d: `tap ${tapLog}\r` });

  const ready = await ctx.daemon.client.sendRequest('session.message', {
    session: id,
    text: 'ready',
  });

  await waitFor(async () => {
    const read = await ctx.daemon.client.sendRequest('message.get', { message: ready['message'] });

    expect(read).toMatchObject({ status: 'delivered' });
  });

  ctx.port.startGuestByteDrop();

  const lost = await ctx.daemon.client.sendRequest('session.message', {
    session: id,
    text: 'lost ack',
  });

  await waitFor(() => {
    expect(readFileSync(tapLog, 'utf8')).toInclude(`"id":"${String(lost['message'])}"`);
  });

  const unacked = await ctx.daemon.client.sendRequest('message.get', { message: lost['message'] });

  ctx.port.stopGuestByteDrop();
  ctx.port.stopRelays();

  await waitFor(async () => {
    const read = await ctx.daemon.client.sendRequest('message.get', { message: lost['message'] });

    const printed = readFileSync(tapLog, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line): unknown => JSON.parse(line));

    expect(read['status']).toBe('delivered');
    expect(printed).toMatchObject([{ id: ready['message'] }, { id: lost['message'] }]);
  });

  expect(unacked['status']).toBe('queued');
});

test("it records a remote session's note, needs-input and turn-done after impd closes its hook forward", async () => {
  const ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = String(getRecord(spawned, 'session')['id']);

  // The bridge socket is named for the session id, lowercased, with only
  // letters and digits kept, cut to 16 characters.
  const socketName = id
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/g, '')
    .slice(0, 16);

  const socketPath = join(ctx.guestDir, 'run', `${socketName}.sock`);

  await waitFor(() => {
    expect(existsSync(socketPath)).toBeTrue();
  });

  ctx.port.stopForwards({ kind: 'closed', code: 1006, reason: '' });

  const closedSocket = existsSync(socketPath);

  await waitFor(() => {
    expect(existsSync(socketPath)).toBeTrue();
  });

  await ctx.daemon.client.sendRequest('session.input', {
    session: id,
    d: 'note after the forward closed\r',
  });

  await ctx.daemon.client.sendRequest('session.input', {
    session: id,
    d: 'notify Claude needs your permission to use Bash\r',
  });

  await ctx.daemon.client.sendRequest('session.input', { session: id, d: 'stop\r' });

  await waitFor(async () => {
    const read = await ctx.daemon.client.sendRequest('events.read', { session: id });

    expect(read['events']).toMatchObject([
      { kind: 'note', label: 'progress', detail: 'after the forward closed' },
      { kind: 'needs-input', detail: 'Claude needs your permission to use Bash' },
      { kind: 'turn-done', detail: null },
    ]);
  });

  expect(closedSocket).toBeFalse();
});
