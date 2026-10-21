import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestDaemon } from '@atc/daemon/testing';
import {
  buildMockAgentAdapter,
  setupTempDir,
  spawnNamedSession,
  startStubSessionBridge,
  updateEnv,
  waitFor,
} from '@atc/test-utils';
import { runTap } from './tap';

async function setupTest() {
  // The adapter takes messages, so a session has an inbox to tap.
  const testDaemon = await startTestDaemon({
    prefix: 'atc-tap-',
    options: () => ({ adapter: buildMockAgentAdapter({ takesMessages: true }) }),
  });

  return {
    directory: testDaemon.directory,
    socketPath: testDaemon.socketPath,
    actor: testDaemon.client,
    events: testDaemon.events,
    daemon: testDaemon.daemon,
    openClient: testDaemon.openClient,
  };
}

test('it writes each pending message as an NDJSON line and acks it', async () => {
  const ctx = await setupTest();

  const id = await spawnNamedSession(
    (method, params) => ctx.actor.sendRequest(method, params),
    'one',
    ctx.directory,
  );

  const first = await ctx.actor.sendRequest('session.message', {
    session: id,
    text: 'one',
  });

  const second = await ctx.actor.sendRequest('session.message', {
    session: id,
    text: 'two',
  });

  const printed: string[] = [];

  const tapped = runTap(id, 'atc/test-build', ctx.socketPath, {
    writeStdout: (text) => {
      printed.push(text);

      return Promise.resolve();
    },
    printError: () => {},
    exit: () => {},
  });

  onTestFinished(() => tapped);

  await waitFor(() => {
    expect(
      ctx.events.filter(
        (daemonEvent) => daemonEvent.ev === 'SessionMessage' && daemonEvent.status === 'delivered',
      ),
    ).toHaveLength(2);
  });

  expect(printed.map((line): unknown => JSON.parse(line))).toStrictEqual([
    {
      id: first['message'],
      from: 'owner',
      sender: { kind: 'owner', name: 'owner' },
      text: 'one',
      sentAt: expect.toBeNumber(),
    },
    {
      id: second['message'],
      from: 'owner',
      sender: { kind: 'owner', name: 'owner' },
      text: 'two',
      sentAt: expect.toBeNumber(),
    },
  ]);
});

test('it exits 1 with a hint when no daemon listens', async () => {
  const temporaryDirectory = setupTempDir('atc-tap-');
  const errors: string[] = [];
  const codes: number[] = [];

  await runTap(
    's1',
    'atc/test-build',
    join(temporaryDirectory.path, 'no-daemon', 'atc-daemon.sock'),
    {
      writeStdout: () => Promise.resolve(),
      printError: (line) => {
        errors.push(line);
      },
      exit: (code) => {
        codes.push(code);
      },
    },
  );

  expect({ codes, errors }).toStrictEqual({
    codes: [1],
    errors: [
      `atc tap: no daemon at ${join(temporaryDirectory.path, 'no-daemon', 'atc-daemon.sock')} — start atc first`,
    ],
  });
});

test('it exits 1 with the refusal when the session cannot be tapped', async () => {
  const ctx = await setupTest();

  const errors: string[] = [];
  const codes: number[] = [];

  await runTap('nope', 'atc/test-build', ctx.socketPath, {
    writeStdout: () => Promise.resolve(),
    printError: (line) => {
      errors.push(line);
    },
    exit: (code) => {
      codes.push(code);
    },
  });

  expect({ codes, errors }).toStrictEqual({
    codes: [1],
    errors: ["atc tap: no_such_session: no session 'nope'"],
  });
});

test('it exits 0 once the daemon closes the connection', async () => {
  const ctx = await setupTest();

  const id = await spawnNamedSession(
    (method, params) => ctx.actor.sendRequest(method, params),
    'one',
    ctx.directory,
  );

  const codes: number[] = [];

  const tapped = runTap(id, 'atc/test-build', ctx.socketPath, {
    writeStdout: () => Promise.resolve(),
    printError: () => {},
    exit: (code) => {
      codes.push(code);
    },
  });

  onTestFinished(() => tapped);

  await ctx.actor.sendRequest('session.message', { session: id, text: 'ping' });

  // A message reaching delivered proves the tap is connected before the
  // daemon goes away.
  await waitFor(() => {
    expect(ctx.events).toPartiallyContain({ ev: 'SessionMessage', status: 'delivered' });
  });

  await ctx.daemon.stop();

  await tapped;

  expect(codes).toStrictEqual([0]);
});

test('it exits 0 when another tap replaces it', async () => {
  const ctx = await setupTest();

  const id = await spawnNamedSession(
    (method, params) => ctx.actor.sendRequest(method, params),
    'one',
    ctx.directory,
  );

  const codes: number[] = [];

  const tapped = runTap(id, 'atc/test-build', ctx.socketPath, {
    writeStdout: () => Promise.resolve(),
    printError: () => {},
    exit: (code) => {
      codes.push(code);
    },
  });

  onTestFinished(() => tapped);

  await ctx.actor.sendRequest('session.message', { session: id, text: 'ping' });

  // A message reaching delivered proves the tap is subscribed.
  await waitFor(() => {
    expect(ctx.events).toPartiallyContain({ ev: 'SessionMessage', status: 'delivered' });
  });

  const replacement = await ctx.openClient();

  await replacement.sendRequest('session.tap', { session: id });

  await tapped;

  expect(codes).toStrictEqual([0]);
});

test('it taps through the session bridge inside a remote host', async () => {
  const temporaryDirectory = setupTempDir('atc-tap-');
  const sock = join(temporaryDirectory.path, 'bridge.sock');
  const outbox = join(temporaryDirectory.path, 'outbox');

  // The bridge closes the inbox once it answers the note the tap sends.
  const bridge = startStubSessionBridge(sock, (request) => [
    { id: request['id'], ok: true },
    { ev: 'InboxClosed' },
  ]);

  mkdirSync(outbox);

  writeFileSync(
    join(outbox, 'r1.json'),
    JSON.stringify({ noteID: 'r1', payload: { kind: 'note', label: 'progress', text: 'hi' } }),
  );

  updateEnv('ATC_BRIDGE', '1');
  updateEnv('ATC_SOCKET', sock);
  updateEnv('ATC_OUTBOX', outbox);

  const codes: number[] = [];

  await runTap('s1', 'atc/test-build', join(temporaryDirectory.path, 'atc-daemon.sock'), {
    writeStdout: () => Promise.resolve(),
    printError: () => {},
    exit: (code) => {
      codes.push(code);
    },
  });

  expect(codes).toStrictEqual([0]);

  expect(bridge.requests).toStrictEqual([
    { version: 1, id: 'tap.open', op: 'tap.open' },
    {
      version: 1,
      id: 'note:r1',
      op: 'note',
      noteID: 'r1',
      payload: { kind: 'note', label: 'progress', text: 'hi' },
    },
  ]);
});
