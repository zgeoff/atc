import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeAdapter } from '../agents/claude-adapter';
import { openBridgeSocket } from '../protocol/open-bridge-socket';
import { sendBridgeRequest } from '../protocol/send-bridge-request';
import { parseConfig } from '../shared/config';
import { getRecord } from '../shared/get-record';
import { createStubGuestCLIs } from '../test-utils/create-stub-guest-clis';
import { FixtureImpPort } from '../test-utils/fixture-imp-port';
import { getAgentEntry } from '../test-utils/get-agent-entry';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { waitFor } from '../test-utils/wait-for';
import { ImpProvider } from './imp-provider';

// A real daemon whose one target `box`, its default, runs Claude sessions
// on the imp provider over a fixture imp port, with the guest folder under
// a temp directory, the stub guest atc running this source tree, and the
// stub claude as Claude's binary.
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const tmp = stack.use(setupTempDir('atc-imp-bridge-'));
  const clis = createStubGuestCLIs(join(tmp.dir, 'bin'));
  const guestDir = join(tmp.dir, 'g');
  const port = stack.use(new FixtureImpPort());
  const config = parseConfig({ claudeBin: clis.claude });

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-bridge-daemon-',
    options: () => ({
      adapter: new ClaudeAdapter(getAgentEntry(config, 'claude'), config),
      targets: [
        {
          id: 'box',
          kind: 'imp',
          options: {},
          identity: 'imp:test',
          provider: new ImpProvider(
            port,
            { guestDir, guestATC: clis.atc },
            { reconnectDelaysMs: [0, 0, 0], atcBinary: null },
          ),
        },
      ],
      defaultTarget: 'box',
    }),
  });

  stack.use(daemon);

  const owned = stack.move();

  return {
    daemon,
    port,
    dir: tmp.dir,
    guestDir,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test("it delivers a message to a remote session's tap", async () => {
  await using ctx = await setupTest();

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
  await using ctx = await setupTest();

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
  await using ctx = await setupTest();

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
  await using ctx = await setupTest();

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

  socket.writeLine({ v: 1, id: 'list', op: 'session.list' });

  await socket.closed;

  expect(answers).toStrictEqual([{ id: 'list', ok: false, code: 'forbidden' }]);
});

test('it delivers a message sent after a sleep and a wake to the tap that ran before, and each message once', async () => {
  await using ctx = await setupTest();

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
        from: expect.toBeString(),
        text: 'before',
        sentAt: expect.toBeNumber(),
      },
      {
        id: after['message'],
        from: expect.toBeString(),
        text: 'after',
        sentAt: expect.toBeNumber(),
      },
    ]);
  });
});

test('it delivers a message and a report held back while the bridge was unreachable once each after it reconnects', async () => {
  await using ctx = await setupTest();

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

  ctx.port.stopRelayRefusal();

  await waitFor(() => {
    const printed = readFileSync(tapLog, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line): unknown => JSON.parse(line));

    expect({
      printed,
      reports: ctx.daemon.events.filter((event) => event.ev === 'SessionReport'),
    }).toMatchObject({
      printed: [{ id: first['message'] }, { id: held['message'] }],
      reports: [{ text: 'while away' }],
    });
  });
});

test('it prints a message whose ack was lost once, and acks it again when the tap reconnects', async () => {
  await using ctx = await setupTest();

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

    expect({ unacked, read, printed }).toMatchObject({
      unacked: { status: 'accepted' },
      read: { status: 'delivered' },
      printed: [{ id: ready['message'] }, { id: lost['message'] }],
    });
  });
});
