import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import { spawnNamedSession } from '../../test/spawn-named-session';
import { waitFor } from '../../test/wait-for';
import type { AgentAdapter } from '../agents/agent-adapter';
import { GrokAdapter } from '../agents/grok-adapter';
import { DaemonClient } from '../client/daemon-client';
import { OutboundQueue } from '../protocol/outbound-queue';
import type { EventMsg } from '../protocol/protocol';
import type { HooksConfig } from '../shared/collect-hooks';
import { isRecord } from '../shared/report';
import { startDaemon } from './daemon';

// Protocol-level tests: handshake, errors, and spawn-parameter validation.
// Session behavior against a real fake-claude lives in test/daemon-e2e.test.ts.
const idleAdapter: AgentAdapter = {
  id: 'claude',
  headlessRunner: null,
  screenDetector: null,
  planSpawn: () => ({ bin: 'sleep', args: ['30'] }),
  normalizeHook: () => ({ kind: 'heartbeat' }),
  loadName: () => Promise.resolve(null),
  canResume: () => true,
  buildResumeCommand: () => null,
};

async function setupDaemon(hooks?: HooksConfig): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'atc-daemon-'));
  const sockPath = join(dir, 'daemon.sock');

  const daemon = await startDaemon({
    socketPath: sockPath,
    reporterSocketPath: join(dir, 'reporter.sock'),
    build: 'atc/test-build',
    adapter: idleAdapter,
    dbPath: join(dir, 'state.db'),
    statusPath: join(dir, 'status.json'),
    ...(hooks === undefined ? {} : { hooks }),
  });

  onTestFinished(async () => {
    await daemon.stop();

    rmSync(dir, { recursive: true, force: true });
  });

  return sockPath;
}

async function setupClient(): Promise<DaemonClient> {
  const sockPath = await setupDaemon();
  const client = await DaemonClient.open(sockPath);

  onTestFinished(() => {
    client.stop();
  });

  return client;
}

interface RawClient {
  readonly sendLine: (line: string) => void;
  readonly waitForLine: (count?: number) => Promise<string[]>;
  readonly waitForClose: () => Promise<void>;
}

async function setupRawClient(): Promise<RawClient> {
  const sockPath = await setupDaemon();

  const lines: string[] = [];
  let buffer = '';
  let queue: OutboundQueue | null = null;
  const closed = Promise.withResolvers<void>();

  const socket = await Bun.connect({
    unix: sockPath,
    socket: {
      data(_s, buf) {
        buffer += buf.toString();

        const parts = buffer.split('\n');

        buffer = parts.pop() ?? '';

        lines.push(...parts.filter((part) => part.trim() !== ''));
      },
      drain() {
        queue?.drain();
      },
      close() {
        closed.resolve();
      },
      error() {},
    },
  });

  queue = new OutboundQueue(socket, 8 * 1024 * 1024);

  onTestFinished(() => {
    socket.end();
  });

  return {
    sendLine(line: string) {
      queue?.send(`${line}\n`);
    },
    async waitForLine(count = 1) {
      const deadline = Date.now() + 5000;

      while (lines.length < count && Date.now() < deadline) {
        await Bun.sleep(10);
      }

      if (lines.length < count) {
        throw new Error(`timed out waiting for ${count} lines; got ${JSON.stringify(lines)}`);
      }

      return lines;
    },
    waitForClose: () => closed.promise,
  };
}

test('it answers daemon.hello with the build and limits', async () => {
  const client = await setupClient();
  const ok = await client.sendHello('atc/test-build');

  expect(ok).toStrictEqual({
    daemon: 'atc/test-build',
    limits: { maxLine: 1_048_576, maxChunk: 65_536 },
    lastUsedAgent: 'claude',
  });
});

test('it rejects a protocol version mismatch naming both builds', async () => {
  const raw = await setupRawClient();

  raw.sendLine('{"v":4,"id":1,"m":"daemon.hello","p":{"client":"atc/newer-build"}}');

  const [line] = await raw.waitForLine();

  if (line === undefined) {
    throw new Error('no response line');
  }

  expect(JSON.parse(line)).toStrictEqual({
    v: 3,
    id: 1,
    err: {
      code: 'protocol_mismatch',
      msg: expect.toSatisfy(
        (msg: string) =>
          msg.includes('atc/newer-build') &&
          msg.includes('v4') &&
          msg.includes('v3') &&
          msg.includes('restart the daemon'),
      ) as string,
    },
  });

  await raw.waitForClose();
});

test('it answers daemon.ping after the handshake', async () => {
  const client = await setupClient();

  await client.sendHello('atc/test-build');

  const pong = await client.sendRequest('daemon.ping');

  expect(pong).toStrictEqual({});
});

test('it refuses any request before daemon.hello', async () => {
  const client = await setupClient();

  expect(client.sendRequest('daemon.ping')).rejects.toMatchObject({ code: 'unauthorized' });
});

test('it answers an unknown method with unknown_method and stays connected', async () => {
  const client = await setupClient();

  await client.sendHello('atc/test-build');

  expect(client.sendRequest('session.levitate')).rejects.toMatchObject({ code: 'unknown_method' });

  const pong = await client.sendRequest('daemon.ping');

  expect(pong).toStrictEqual({});
});

test('it closes the connection on a malformed line', async () => {
  const raw = await setupRawClient();

  raw.sendLine('this is not json');

  const [line] = await raw.waitForLine();

  if (line === undefined) {
    throw new Error('no response line');
  }

  expect(JSON.parse(line)).toStrictEqual({
    v: 3,
    id: 0,
    err: { code: 'bad_args', msg: 'malformed line: not valid JSON' },
  });

  await raw.waitForClose();
});

test('it closes the connection on an oversized line', async () => {
  const raw = await setupRawClient();

  raw.sendLine(`{"v":1,"id":1,"m":"daemon.hello","p":{"pad":"${'x'.repeat(1_100_000)}"}}`);

  const [line] = await raw.waitForLine();

  if (line === undefined) {
    throw new Error('no response line');
  }

  expect(JSON.parse(line)).toStrictEqual({
    v: 3,
    id: 0,
    err: { code: 'bad_args', msg: 'line exceeds 1048576 bytes' },
  });

  await raw.waitForClose();
});

test('it lists no sessions on a fresh daemon', async () => {
  const client = await setupClient();

  await client.sendHello('atc/test-build');

  const list = await client.sendRequest('session.list');

  expect(list).toStrictEqual({ sessions: [] });
});

test('it answers session.kill for an unknown session with no_such_session', async () => {
  const client = await setupClient();

  await client.sendHello('atc/test-build');

  expect(client.sendRequest('session.kill', { session: 'nope' })).rejects.toMatchObject({
    code: 'no_such_session',
  });
});

test('it answers session.ack for an unknown session with no_such_session', async () => {
  const client = await setupClient();

  await client.sendHello('atc/test-build');

  expect(client.sendRequest('session.ack', { session: 'nope' })).rejects.toMatchObject({
    code: 'no_such_session',
  });
});

test('it answers session.screen for an unknown session with no_such_session', async () => {
  const client = await setupClient();

  await client.sendHello('atc/test-build');

  expect(client.sendRequest('session.screen', { session: 'nope' })).rejects.toMatchObject({
    code: 'no_such_session',
  });
});

test('it answers session.resumeCommand for an unknown session with no_such_session', async () => {
  const client = await setupClient();

  await client.sendHello('atc/test-build');

  expect(client.sendRequest('session.resumeCommand', { session: 'nope' })).rejects.toMatchObject({
    code: 'no_such_session',
  });
});

test('it rejects session.spawn without a cwd as bad_args', async () => {
  const client = await setupClient();

  await client.sendHello('atc/test-build');

  expect(client.sendRequest('session.spawn', {})).rejects.toMatchObject({ code: 'bad_args' });
});

test('it reports agent claude when session.spawn omits agent', async () => {
  const client = await setupClient();

  await client.sendHello('atc/test-build');

  const ok = await client.sendRequest('session.spawn', { cwd: '/tmp', cols: 80, rows: 24 });

  expect(ok['session']).toMatchObject({ agent: 'claude' });
});

test('it refuses session.spawn with agent grok as unsupported', async () => {
  const client = await setupClient();

  await client.sendHello('atc/test-build');

  expect(client.sendRequest('session.spawn', { cwd: '/tmp', agent: 'grok' })).rejects.toMatchObject(
    { code: 'unsupported' },
  );

  const list = await client.sendRequest('session.list');

  expect(list).toStrictEqual({ sessions: [] });

  const fleet = await client.sendRequest('fleet.list');

  expect(fleet).toStrictEqual({ fleet: [] });
});

test('it spawns a grok session when a grok adapter is registered', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atc-daemon-'));
  const prevHome = process.env['GROK_HOME'];

  process.env['GROK_HOME'] = join(dir, 'grok-home');

  const grok = new GrokAdapter({
    claudeBin: 'claude',
    claudeArgs: [],
    grokBin: 'bash',
    grokArgs: ['-c', 'sleep 30'],
    codexBin: 'codex',
    codexArgs: [],
    gateways: [],
    hooks: {},
    leader: { code: 0, label: '^Space' },
  });

  const daemon = await startDaemon({
    socketPath: join(dir, 'daemon.sock'),
    reporterSocketPath: join(dir, 'reporter.sock'),
    build: 'atc/test-build',
    adapter: idleAdapter,
    adapters: [grok],
    dbPath: join(dir, 'state.db'),
    statusPath: join(dir, 'status.json'),
  });

  const client = await DaemonClient.open(join(dir, 'daemon.sock'));

  onTestFinished(async () => {
    client.stop();

    await daemon.stop();

    if (prevHome === undefined) {
      delete process.env['GROK_HOME'];
    } else {
      process.env['GROK_HOME'] = prevHome;
    }

    rmSync(dir, { recursive: true, force: true });
  });

  await client.sendHello('atc/test-build');

  const ok = await client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'grok',
    cols: 80,
    rows: 24,
  });

  expect(ok['session']).toMatchObject({ agent: 'grok' });
});

test('it yanks a grok session by id and without an id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atc-daemon-'));
  const prevHome = process.env['GROK_HOME'];

  process.env['GROK_HOME'] = join(dir, 'grok-home');

  const grok = new GrokAdapter({
    claudeBin: 'claude',
    claudeArgs: [],
    grokBin: 'bash',
    grokArgs: ['-c', 'sleep 30'],
    codexBin: 'codex',
    codexArgs: [],
    gateways: [],
    hooks: {},
    leader: { code: 0, label: '^Space' },
  });

  const daemon = await startDaemon({
    socketPath: join(dir, 'daemon.sock'),
    reporterSocketPath: join(dir, 'reporter.sock'),
    build: 'atc/test-build',
    adapter: idleAdapter,
    adapters: [grok],
    dbPath: join(dir, 'state.db'),
    statusPath: join(dir, 'status.json'),
  });

  const client = await DaemonClient.open(join(dir, 'daemon.sock'));

  onTestFinished(async () => {
    client.stop();

    await daemon.stop();

    if (prevHome === undefined) {
      delete process.env['GROK_HOME'];
    } else {
      process.env['GROK_HOME'] = prevHome;
    }

    rmSync(dir, { recursive: true, force: true });
  });

  await client.sendHello('atc/test-build');

  const withID = await client.sendRequest('session.spawn', {
    cwd: '/tmp/proj',
    agent: 'grok',
    resume: 'g-1',
    cols: 80,
    rows: 24,
  });

  const withoutID = await client.sendRequest('session.spawn', {
    cwd: '/tmp/proj',
    agent: 'grok',
    cols: 80,
    rows: 24,
  });

  const withSession = withID['session'];
  const withoutSession = withoutID['session'];

  if (
    !isRecord(withSession) ||
    typeof withSession['id'] !== 'string' ||
    !isRecord(withoutSession) ||
    typeof withoutSession['id'] !== 'string'
  ) {
    throw new Error('no session in spawn answer');
  }

  const resumed = await client.sendRequest('session.resumeCommand', { session: withSession['id'] });

  const welcome = await client.sendRequest('session.resumeCommand', {
    session: withoutSession['id'],
  });

  expect(resumed).toStrictEqual({ command: "cd '/tmp/proj' && grok --resume g-1" });
  expect(welcome).toStrictEqual({ command: "cd '/tmp/proj' && grok" });
});

test('it revives a grok session from a captured id when summary.json is missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atc-daemon-'));
  const prevHome = process.env['GROK_HOME'];

  process.env['GROK_HOME'] = join(dir, 'grok-home');

  const grok = new GrokAdapter({
    claudeBin: 'claude',
    claudeArgs: [],
    grokBin: 'bash',
    grokArgs: ['-c', 'sleep 30'],
    codexBin: 'codex',
    codexArgs: [],
    gateways: [],
    hooks: {},
    leader: { code: 0, label: '^Space' },
  });

  const daemon = await startDaemon({
    socketPath: join(dir, 'daemon.sock'),
    reporterSocketPath: join(dir, 'reporter.sock'),
    build: 'atc/test-build',
    adapter: idleAdapter,
    adapters: [grok],
    dbPath: join(dir, 'state.db'),
    statusPath: join(dir, 'status.json'),
  });

  const client = await DaemonClient.open(join(dir, 'daemon.sock'));

  onTestFinished(async () => {
    client.stop();

    await daemon.stop();

    if (prevHome === undefined) {
      delete process.env['GROK_HOME'];
    } else {
      process.env['GROK_HOME'] = prevHome;
    }

    rmSync(dir, { recursive: true, force: true });
  });

  await client.sendHello('atc/test-build');

  const ok = await client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'grok',
    resume: 'g-revive',
    cols: 80,
    rows: 24,
  });

  const spawned = ok['session'];

  if (!isRecord(spawned) || typeof spawned['id'] !== 'string') {
    throw new Error('no session in spawn answer');
  }

  await client.sendRequest('session.kill', { session: spawned['id'] });

  const adopted = await client.sendRequest('session.adopt', {
    session: spawned['id'],
    cols: 80,
    rows: 24,
  });

  expect(adopted).toStrictEqual({});
});

test('it writes last-used on SessionStart and ignores a spawn that never reports', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atc-daemon-'));
  const prevHome = process.env['GROK_HOME'];

  process.env['GROK_HOME'] = join(dir, 'grok-home');

  const reporterPath = join(dir, 'reporter.sock');
  const sockPath = join(dir, 'daemon.sock');

  const grok = new GrokAdapter({
    claudeBin: 'claude',
    claudeArgs: [],
    grokBin: 'bash',
    grokArgs: ['-c', 'sleep 30'],
    codexBin: 'codex',
    codexArgs: [],
    gateways: [],
    hooks: {},
    leader: { code: 0, label: '^Space' },
  });

  const daemon = await startDaemon({
    socketPath: sockPath,
    reporterSocketPath: reporterPath,
    build: 'atc/test-build',
    adapter: idleAdapter,
    adapters: [grok],
    dbPath: join(dir, 'state.db'),
    statusPath: join(dir, 'status.json'),
  });

  const client = await DaemonClient.open(sockPath);

  onTestFinished(async () => {
    client.stop();

    await daemon.stop();

    if (prevHome === undefined) {
      delete process.env['GROK_HOME'];
    } else {
      process.env['GROK_HOME'] = prevHome;
    }

    rmSync(dir, { recursive: true, force: true });
  });

  await client.sendHello('atc/test-build');

  const spawned = await client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'grok',
    cols: 80,
    rows: 24,
  });

  const session = spawned['session'];

  if (!isRecord(session) || typeof session['id'] !== 'string') {
    throw new Error('no session in spawn answer');
  }

  const afterSpawn = await DaemonClient.open(sockPath);

  onTestFinished(() => {
    afterSpawn.stop();
  });

  const helloAfterSpawn = await afterSpawn.sendHello('atc/test-build');

  expect(helloAfterSpawn).toMatchObject({ lastUsedAgent: 'claude' });

  await sendHookEvent(reporterPath, {
    atcId: session['id'],
    event: 'SessionStart',
    payload: { sessionId: 'g-last' },
  });

  const afterStart = await waitForLastUsedAgent(sockPath, 'grok');

  expect(afterStart).toBe('grok');

  const claudeSpawn = await client.sendRequest('session.spawn', {
    cwd: '/tmp',
    cols: 80,
    rows: 24,
  });

  expect(claudeSpawn['session']).toMatchObject({ agent: 'claude' });
});

test('it rejects session.spawn with an unregistered agent id as unsupported', async () => {
  const client = await setupClient();

  await client.sendHello('atc/test-build');

  expect(
    client.sendRequest('session.spawn', { cwd: '/tmp', agent: 'gemini' }),
  ).rejects.toMatchObject({ code: 'unsupported' });
});

test('it rejects session.spawn with an empty agent id as bad_args', async () => {
  const client = await setupClient();

  await client.sendHello('atc/test-build');

  expect(client.sendRequest('session.spawn', { cwd: '/tmp', agent: '' })).rejects.toMatchObject({
    code: 'bad_args',
  });
});

interface HookEventLine {
  readonly atcId: string;
  readonly event: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

async function sendHookEvent(reporterPath: string, event: HookEventLine) {
  const closed = Promise.withResolvers<void>();

  await Bun.connect({
    unix: reporterPath,
    socket: {
      open(socket) {
        socket.write(`${JSON.stringify(event)}\n`);
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
}

async function waitForLastUsedAgent(sockPath: string, agent: 'claude' | 'grok'): Promise<string> {
  const deadline = Date.now() + 2000;

  while (Date.now() < deadline) {
    const probe = await DaemonClient.open(sockPath);
    const hello = await probe.sendHello('atc/test-build');

    probe.stop();

    if (hello['lastUsedAgent'] === agent) {
      return agent;
    }

    await Bun.sleep(20);
  }

  throw new Error(`lastUsedAgent never became ${agent}`);
}

test('it connects nothing on a socket path with no daemon', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atc-daemon-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const attempt = Bun.connect({
    unix: join(dir, 'nobody-home.sock'),
    socket: { data() {}, error() {} },
  });

  expect(attempt).rejects.toMatchObject({ code: 'ENOENT' });
});

interface WatchedPair {
  readonly actor: DaemonClient;
  readonly events: EventMsg[];
  readonly [Symbol.asyncDispose]: () => Promise<void>;
}

async function setupTest(hooks?: HooksConfig): Promise<WatchedPair> {
  const sockPath = await setupDaemon(hooks);
  const watcher = await DaemonClient.open(sockPath);
  const actor = await DaemonClient.open(sockPath);

  const events: EventMsg[] = [];

  watcher.onEvent = (e) => {
    events.push(e);
  };

  await watcher.sendHello('atc/test-build');
  await actor.sendHello('atc/test-build');

  return {
    actor,
    events,
    [Symbol.asyncDispose]: () => {
      watcher.stop();
      actor.stop();

      return Promise.resolve();
    },
  };
}

test('it broadcasts SessionAttached with the session descriptor when a client attaches', async () => {
  await using pair = await setupTest();

  const sessionID = await spawnNamedSession(
    (m, p) => pair.actor.sendRequest(m, p),
    'focus-me',
    '/tmp',
  );

  await pair.actor.sendRequest('session.attach', { session: sessionID, cols: 80, rows: 24 });

  const event = await waitFor(() => {
    const found = pair.events.find((e) => e.ev === 'SessionAttached');

    if (found === undefined) {
      throw new Error('no SessionAttached yet');
    }

    return found;
  });

  expect(event).toMatchObject({
    v: 3,
    ev: 'SessionAttached',
    session: {
      id: sessionID,
      name: 'focus-me',
      cwd: '/tmp',
      agent: 'claude',
      kind: 'pty',
      alive: true,
      unread: false,
    },
  });
});

test('it broadcasts SessionDetached when an attached client detaches', async () => {
  await using pair = await setupTest();

  const sessionID = await spawnNamedSession(
    (m, p) => pair.actor.sendRequest(m, p),
    'focus-me',
    '/tmp',
  );

  await pair.actor.sendRequest('session.attach', { session: sessionID, cols: 80, rows: 24 });
  await pair.actor.sendRequest('session.detach', { session: sessionID });

  const event = await waitFor(() => {
    const found = pair.events.find((e) => e.ev === 'SessionDetached');

    if (found === undefined) {
      throw new Error('no SessionDetached yet');
    }

    return found;
  });

  expect(event).toMatchObject({ v: 3, ev: 'SessionDetached', session: { id: sessionID } });
});

test('it broadcasts SessionDetached when an attached client disconnects', async () => {
  await using pair = await setupTest();

  const sessionID = await spawnNamedSession(
    (m, p) => pair.actor.sendRequest(m, p),
    'focus-me',
    '/tmp',
  );

  await pair.actor.sendRequest('session.attach', { session: sessionID, cols: 80, rows: 24 });

  await waitFor(() => {
    if (!pair.events.some((e) => e.ev === 'SessionAttached')) {
      throw new Error('no SessionAttached yet');
    }
  });

  pair.actor.stop();

  const event = await waitFor(() => {
    const found = pair.events.find((e) => e.ev === 'SessionDetached');

    if (found === undefined) {
      throw new Error('no SessionDetached yet');
    }

    return found;
  });

  expect(event).toMatchObject({ ev: 'SessionDetached', session: { id: sessionID } });
});

test('it broadcasts no SessionDetached for a detach without an attach', async () => {
  await using pair = await setupTest();

  const sessionID = await spawnNamedSession(
    (m, p) => pair.actor.sendRequest(m, p),
    'focus-me',
    '/tmp',
  );

  await pair.actor.sendRequest('session.detach', { session: sessionID });
  await pair.actor.sendRequest('session.attach', { session: sessionID, cols: 80, rows: 24 });

  await waitFor(() => {
    if (!pair.events.some((e) => e.ev === 'SessionAttached')) {
      throw new Error('no SessionAttached yet');
    }
  });

  expect(pair.events.filter((e) => e.ev === 'SessionDetached')).toStrictEqual([]);
});

test('it runs a configured hook with the same event JSON a watching client receives', async () => {
  await using hookOut = setupTempDir('atc-hook-out-');

  const out = join(hookOut.dir, 'hook.out');

  await using pair = await setupTest({
    SessionAttached: [{ command: `cat > '${out}'; printf '%s\n' "$ATC_EVENT" >> '${out}'` }],
  });

  const sessionID = await spawnNamedSession(
    (m, p) => pair.actor.sendRequest(m, p),
    'focus-me',
    '/tmp',
  );

  await pair.actor.sendRequest('session.attach', { session: sessionID, cols: 80, rows: 24 });

  const event = await waitFor(() => {
    const found = pair.events.find((e) => e.ev === 'SessionAttached');

    if (found === undefined) {
      throw new Error('no SessionAttached yet');
    }

    return found;
  });

  const text = await waitFor(() => {
    const written = readFileSync(out, 'utf8');

    if (!written.endsWith('SessionAttached\n')) {
      throw new Error('hook output still incomplete');
    }

    return written;
  });

  const [payload, eventName] = text.split('\n');

  if (payload === undefined) {
    throw new Error('hook wrote no payload line');
  }

  expect(JSON.parse(payload)).toStrictEqual(event);
  expect(eventName).toBe('SessionAttached');
});
