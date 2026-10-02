import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import { waitFor } from '../../test/wait-for';
import { DaemonClient } from '../client/daemon-client';
import { DaemonError } from '../protocol/daemon-error';
import type { EventMsg } from '../protocol/protocol';
import { collectPrincipals } from '../shared/collect-principals';
import { collectTargets } from '../shared/collect-targets';
import { getRecord } from '../shared/get-record';
import { buildTargetIdentity } from './build-target-identity';
import { startDaemon } from './daemon';
import { LocalPTYProvider } from './local-pty-provider';

// The `targets` and `principals` keys of a config.json, raw.
interface RawConfig {
  readonly targets?: unknown;
  readonly principals?: unknown;
}

/**
 * A real daemon whose targets and principals come from a raw config through
 * the real parse. Every target runs harnesses on a real pseudo-terminal
 * through a provider that counts its spawns. `client` is the daemon owner's
 * connection; `openClientAs` opens a connection whose handshake gives a
 * principal.
 */
async function setupTest(raw: RawConfig) {
  const tmp = setupTempDir('atc-daemon-principals-');
  const socketPath = join(tmp.dir, 'daemon.sock');

  const local = new LocalPTYProvider();

  const harnesses: string[] = [];
  const targets = collectTargets(raw.targets, undefined);

  const daemon = await startDaemon({
    socketPath,
    reporterSocketPath: join(tmp.dir, 'reporter.sock'),
    build: 'atc/test-build',
    adapter: {
      id: 'claude',
      screenDetector: null,
      takesMessages: false,
      headlessRunner: null,
      planSpawn: () => ({ bin: 'sleep', args: ['30'] }),
      normalizeHook: () => ({ kind: 'prompt-submitted' }),
      loadName: () => Promise.resolve(null),
      canResume: () => true,
      buildResumeCommand: () => 'claude --resume',
    },
    dbPath: join(tmp.dir, 'state.db'),
    statusPath: join(tmp.dir, 'status.json'),
    targets: targets.targets.map((target) => ({
      id: target.id,
      kind: target.provider,
      options: target.options,
      identity: buildTargetIdentity(target.provider, target.options),
      provider: {
        kind: target.provider,
        capabilities: local.capabilities,
        spawnHarness: (spec) => {
          harnesses.push(target.id);

          return local.spawnHarness(spec);
        },
        transferArchive: local.transferArchive,
        runCommand: local.runCommand,
      },
    })),
    defaultTarget: targets.defaultTarget,
    targetErrors: targets.errors,
    principals: collectPrincipals(raw.principals).principals,
  });

  const clients: DaemonClient[] = [];

  const openClient = async (hello: Readonly<Record<string, unknown>>) => {
    const client = await DaemonClient.open(socketPath);

    clients.push(client);

    await client.sendRequest('daemon.hello', hello);

    return client;
  };

  const client = await openClient({ client: 'atc/test-build' });

  return {
    client,
    harnesses,
    openClientAs: (principal: unknown) => openClient({ client: 'atc/test-build', principal }),

    // Reports one hook event for the session, which the daemon records in
    // its trail.
    async sendHookEvent(sessionID: string): Promise<void> {
      const closed = Promise.withResolvers<void>();
      const line = { atcId: sessionID, event: 'UserPromptSubmit', payload: {} };

      await Bun.connect({
        unix: join(tmp.dir, 'reporter.sock'),
        socket: {
          open(socket) {
            socket.write(`${JSON.stringify(line)}\n`);
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
    async spawnOn(target: string): Promise<string> {
      const spawned = await client.sendRequest('session.spawn', { cwd: '/tmp', target });

      return String(getRecord(spawned, 'session')['id']);
    },
    async [Symbol.asyncDispose]() {
      for (const opened of clients) {
        opened.stop();
      }

      await daemon.stop();

      tmp[Symbol.dispose]();
    },
  };
}

// A request's answer or refusal as plain data, with the session id it
// addressed replaced, so the answers for two ids compare whole.
async function readAnswer(
  send: () => Promise<Readonly<Record<string, unknown>>>,
  sessionID: string,
): Promise<unknown> {
  const answer = await send().then(
    (ok) => ({ ok }),
    (error: unknown) => ({ error: readError(error) }),
  );

  return JSON.parse(JSON.stringify(answer).replaceAll(sessionID, '<session>'));
}

// A refusal's code, message, and data.
function readError(error: unknown): unknown {
  if (!(error instanceof DaemonError)) {
    throw error;
  }

  return { code: error.code, message: error.message, data: error.data ?? null };
}

test('it refuses a client a configured target other than local when the config has no principals', async () => {
  await using daemon = await setupTest({
    targets: { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
  });

  expect(
    daemon.client.sendRequest('session.spawn', { cwd: '/tmp', target: 'box' }, 'client-a'),
  ).rejects.toMatchObject({ code: 'target_forbidden', data: { target: 'box' } });

  await daemon.client.sendRequest('session.spawn', { cwd: '/tmp', target: 'local' }, 'client-a');

  expect(daemon.harnesses).toStrictEqual(['local']);
});

test('it refuses a client a local target that holds other options when the config has no principals', async () => {
  await using daemon = await setupTest({
    targets: { local: { provider: 'local-pty', shell: 'zsh' } },
  });

  const id = await daemon.spawnOn('local');

  expect(
    daemon.client.sendRequest('session.spawn', { cwd: '/tmp', target: 'local' }, 'client-a'),
  ).rejects.toMatchObject({ code: 'target_forbidden', data: { target: 'local' } });

  expect(
    daemon.client.sendRequest('session.spawn', { cwd: '/tmp' }, 'client-a'),
  ).rejects.toMatchObject({ code: 'target_forbidden', data: { target: 'local' } });

  expect(
    daemon.client.sendRequest('session.get', { session: id }, 'client-a'),
  ).rejects.toMatchObject({ code: 'no_such_session' });

  const listed = await daemon.client.sendRequest('session.list', {}, 'client-a');

  expect(listed).toStrictEqual({ sessions: [] });
  expect(daemon.harnesses).toStrictEqual(['local']);
});

test('it gives a client the implicit local target when the config has no targets or principals', async () => {
  await using daemon = await setupTest({});

  const spawned = await daemon.client.sendRequest('session.spawn', { cwd: '/tmp' }, 'client-a');
  const listed = await daemon.client.sendRequest('session.list', {}, 'client-a');

  expect(listed).toMatchObject({ sessions: [{ id: getRecord(spawned, 'session')['id'] }] });
  expect(daemon.harnesses).toStrictEqual(['local']);
});

test.each([
  ['a principal the config does not hold', 'client-c'],
  ['a principal granted an empty list', 'client-b'],
])('it gives %s no target and no session', async (_label, principal) => {
  await using daemon = await setupTest({
    targets: { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
    principals: { 'client-a': { targets: ['local', 'box'] }, 'client-b': { targets: [] } },
  });

  await daemon.spawnOn('local');

  expect(
    daemon.client.sendRequest('session.spawn', { cwd: '/tmp' }, principal),
  ).rejects.toMatchObject({ code: 'target_forbidden' });

  const listed = await daemon.client.sendRequest('session.list', {}, principal);
  const agents = await daemon.client.sendRequest('agents.list', {}, principal);

  expect(listed).toStrictEqual({ sessions: [] });
  expect(agents).toMatchObject({ targets: [], spawnDefaults: { target: null } });
  expect(daemon.harnesses).toStrictEqual(['local']);
});

test.each([
  ['session.get', {}],
  ['session.read', {}],
  ['session.screen', {}],
  ['session.attach', { cols: 80, rows: 24 }],
  ['session.input', { d: 'go\r' }],
  ['session.message', { from: 'remote', text: 'hello' }],
  ['session.kill', {}],
  ['session.update', { name: 'renamed' }],
  ['session.ack', {}],
  ['session.adopt', { cols: 80, rows: 24 }],
  ['session.eject', { prompt: 'carry on' }],
  ['session.resumeCommand', {}],
  ['session.tap', {}],
  ['session.resize', { cols: 80, rows: 24 }],
  ['events.read', { waitMs: 0 }],
])(
  'it answers %s for a session outside the principal as for a session that does not exist',
  async (method, params) => {
    await using daemon = await setupTest({
      targets: { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
      principals: { 'client-a': { targets: ['local'] } },
    });

    const hidden = await daemon.spawnOn('box');

    const missing = randomUUID();

    // The hidden session has a trail of its own, so a read that reached it
    // would differ.
    await daemon.sendHookEvent(hidden);

    await waitFor(async () => {
      const owner = await daemon.client.sendRequest('events.read', { session: hidden, waitMs: 0 });

      expect(JSON.stringify(owner)).toContain(hidden);
    });

    const answered = await readAnswer(
      () => daemon.client.sendRequest(method, { ...params, session: hidden }, 'client-a'),
      hidden,
    );

    const unknown = await readAnswer(
      () => daemon.client.sendRequest(method, { ...params, session: missing }, 'client-a'),
      missing,
    );

    const listed = await daemon.client.sendRequest('session.list');

    expect(answered).toStrictEqual(unknown);
    expect(listed).toMatchObject({ sessions: [{ id: hidden, name: 'tmp', alive: true }] });
  },
);

test('it leaves the events of a session outside the principal out of an unfiltered read', async () => {
  await using daemon = await setupTest({
    targets: { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
    principals: { 'client-a': { targets: ['local'] } },
  });

  const shown = await daemon.spawnOn('local');
  const hidden = await daemon.spawnOn('box');

  await daemon.sendHookEvent(hidden);
  await daemon.sendHookEvent(shown);

  await waitFor(async () => {
    const owner = await daemon.client.sendRequest('events.read', { waitMs: 0 });

    expect(JSON.stringify(owner)).toContain(hidden);
  });

  const read = await daemon.client.sendRequest('events.read', { waitMs: 0 }, 'client-a');

  expect(JSON.stringify(read)).not.toContain(hidden);
  expect(JSON.stringify(read)).toContain(shown);
});

test('it narrows a request on an owner connection to the principal it acts as', async () => {
  await using daemon = await setupTest({
    targets: { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
    principals: {
      narrow: { targets: ['local'] },
      wide: { targets: ['local', 'box'] },
    },
  });

  const shown = await daemon.spawnOn('local');
  const hidden = await daemon.spawnOn('box');
  const narrow = await daemon.client.sendRequest('session.list', {}, 'narrow');
  const wide = await daemon.client.sendRequest('session.list', {}, 'wide');

  expect(narrow).toMatchObject({ sessions: [{ id: shown }] });
  expect(getRecord(narrow, 'sessions')).toHaveLength(1);
  expect(wide).toMatchObject({ sessions: [{ id: shown }, { id: hidden }] });
});

test('it refuses a request a reach wider than the principal its connection acts as', async () => {
  await using daemon = await setupTest({
    targets: { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
    principals: {
      narrow: { targets: ['local'] },
      wide: { targets: ['local', 'box'] },
    },
  });

  const shown = await daemon.spawnOn('local');

  await daemon.spawnOn('box');

  const client = await daemon.openClientAs('narrow');
  const own = await client.sendRequest('session.list');
  const widened = await client.sendRequest('session.list', {}, 'wide');

  expect(
    client.sendRequest('session.spawn', { cwd: '/tmp', target: 'box' }, 'wide'),
  ).rejects.toMatchObject({ code: 'target_forbidden', data: { target: 'box' } });

  expect(client.sendRequest('daemon.quit')).rejects.toMatchObject({ code: 'unauthorized' });
  expect(client.sendRequest('fleet.restore')).rejects.toMatchObject({ code: 'unauthorized' });

  await client.sendRequest('daemon.ping');

  expect(own).toMatchObject({ sessions: [{ id: shown }] });
  expect(getRecord(own, 'sessions')).toHaveLength(1);
  expect(widened).toStrictEqual(own);
  expect(daemon.harnesses).toStrictEqual(['local', 'box']);
});

test('it pushes a principal connection only the events of sessions it may see', async () => {
  await using daemon = await setupTest({
    targets: { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
    principals: { narrow: { targets: ['local'] } },
  });

  const client = await daemon.openClientAs('narrow');

  const events: EventMsg[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  const hidden = await daemon.spawnOn('box');
  const shown = await daemon.spawnOn('local');

  await daemon.client.sendRequest('session.kill', { session: shown });
  await daemon.client.sendRequest('session.kill', { session: shown });

  await waitFor(() => {
    expect(events.some((event) => event.ev === 'SessionRemoved' && event['s'] === shown)).toBe(
      true,
    );
  });

  const added = events.filter((event) => event.ev === 'SessionAdded');

  expect(added).toMatchObject([{ session: { id: shown } }]);
  expect(JSON.stringify(events)).not.toContain(hidden);
});

test('it refuses a handshake whose principal it cannot read', async () => {
  await using daemon = await setupTest({ principals: { narrow: { targets: ['local'] } } });

  expect(daemon.openClientAs(5)).rejects.toMatchObject({ code: 'bad_args' });
});
