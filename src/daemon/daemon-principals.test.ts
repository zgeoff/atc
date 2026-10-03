import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import { waitFor } from '../../test/wait-for';
import { DaemonClient } from '../client/daemon-client';
import { DaemonError } from '../protocol/daemon-error';
import { encodeCursor } from '../protocol/encode-cursor';
import { PROTOCOL_V } from '../protocol/protocol';
import type { EventMsg } from '../protocol/protocol';
import { collectPrincipals } from '../shared/collect-principals';
import { collectTargets } from '../shared/collect-targets';
import { getRecord } from '../shared/get-record';
import { isRecord } from '../shared/report';
import { buildTargetIdentity } from './build-target-identity';
import { startDaemon } from './daemon';
import type { ExecutionCapabilities } from './execution-provider';
import { LocalPTYProvider } from './local-pty-provider';

// The `targets` and `principals` keys of a config.json, raw.
interface RawConfig {
  readonly targets?: unknown;
  readonly principals?: unknown;
}

// What a target's provider does in place of the local one's: the
// capabilities it adds and the host sleep and destroy it runs.
interface HostOverride {
  readonly capabilities?: Partial<ExecutionCapabilities>;
  readonly suspendHost?: (host: string) => Promise<void>;
  readonly destroyHost?: (host: string) => Promise<void>;
}

/**
 * A real daemon whose targets and principals come from a raw config through
 * the real parse. Every target runs harnesses on a real pseudo-terminal
 * through a provider that counts its spawns. `client` is the daemon owner's
 * connection; `openClientAs` opens a connection whose handshake gives a
 * principal. `restart` stops the daemon and starts it again on the same
 * state with another config, running `whileStopped` in between, and
 * `dbPath` is that state. `hosts` gives a target, by its id, capabilities
 * and a host sleep or destroy of its own.
 */
async function setupTest(raw: RawConfig, hosts: Readonly<Record<string, HostOverride>> = {}) {
  const tmp = setupTempDir('atc-daemon-principals-');
  const socketPath = join(tmp.dir, 'daemon.sock');

  const local = new LocalPTYProvider();

  const harnesses: string[] = [];
  const clients: DaemonClient[] = [];

  const openClient = async (hello: Readonly<Record<string, unknown>>) => {
    const client = await DaemonClient.open(socketPath);

    clients.push(client);

    await client.sendRequest('daemon.hello', hello);

    return client;
  };

  const startTestDaemon = (config: RawConfig) => {
    const targets = collectTargets(config.targets, undefined);

    return startDaemon({
      socketPath,
      reporterSocketPath: join(tmp.dir, 'reporter.sock'),
      build: 'atc/test-build',
      adapter: {
        id: 'claude',
        screenDetector: null,
        takesMessages: true,
        headlessRunner: null,
        planSpawn: () => ({ bin: 'sleep', args: ['30'] }),
        normalizeHook: (hook) => ({
          kind: hook.event === 'Notification' ? 'needs-input' : 'prompt-submitted',
        }),
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
          remote: false,
          prepareHost: local.prepareHost,
          dispose: local.dispose,
          capabilities: { ...local.capabilities, ...hosts[target.id]?.capabilities },
          spawnHarness: (spec) => {
            harnesses.push(target.id);

            return local.spawnHarness(spec);
          },
          transferArchive: local.transferArchive,
          runCommand: local.runCommand,
          suspendHost: hosts[target.id]?.suspendHost ?? local.suspendHost,
          destroyHost: hosts[target.id]?.destroyHost ?? local.destroyHost,
        },
      })),
      defaultTarget: targets.defaultTarget,
      targetErrors: targets.errors,
      principals: collectPrincipals(config.principals).principals,
    });
  };

  const stopClients = () => {
    for (const opened of clients.splice(0)) {
      opened.stop();
    }
  };

  let daemon = await startTestDaemon(raw);
  let client = await openClient({ client: 'atc/test-build' });

  return {
    get client() {
      return client;
    },
    harnesses,
    dbPath: join(tmp.dir, 'state.db'),
    openClientAs: (principal: unknown) => openClient({ client: 'atc/test-build', principal }),
    async restart(config: RawConfig, whileStopped: () => void = () => {}): Promise<void> {
      stopClients();

      await daemon.stop();

      whileStopped();

      daemon = await startTestDaemon(config);
      client = await openClient({ client: 'atc/test-build' });
    },

    // Reports one hook event for the session, which the daemon records in
    // its trail: a prompt submit with no payload, unless the test gives
    // another event or a payload.
    async sendHookEvent(
      sessionID: string,
      event = 'UserPromptSubmit',
      payload: Readonly<Record<string, unknown>> = {},
    ): Promise<void> {
      const closed = Promise.withResolvers<void>();
      const line = { atcId: sessionID, event, payload };

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

    // Reports one note for the session, which the daemon records in its
    // trail as a report.
    async sendNote(sessionID: string, text: string): Promise<void> {
      const closed = Promise.withResolvers<void>();

      const line = {
        atcId: sessionID,
        event: 'Report',
        payload: { kind: 'note', label: 'l', text },
      };

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
    async spawnOn(target: string, parent?: string): Promise<string> {
      const spawned = await client.sendRequest('session.spawn', {
        cwd: '/tmp',
        target,
        resume: `a-${randomUUID()}`,
        ...(parent === undefined ? {} : { parent }),
      });

      return String(getRecord(spawned, 'session')['id']);
    },
    async [Symbol.asyncDispose]() {
      stopClients();

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

test.each(
  [
    { label: 'a session on a target outside the principal', targets: ['box'], hidden: 0 },
    {
      label: 'a parent whose sub-session is on a target outside the principal',
      targets: ['local', 'box'],
      hidden: 0,
    },
    {
      label: 'a sub-session whose parent is on a target outside the principal',
      targets: ['box', 'local'],
      hidden: 1,
    },
  ].flatMap((kind) =>
    (
      [
        ['session.get', {}, 'session'],
        ['session.read', {}, 'session'],
        ['session.screen', {}, 'session'],
        ['session.attach', { cols: 80, rows: 24 }, 'session'],
        ['session.input', { d: 'go\r' }, 'session'],
        ['session.submit', { text: 'go' }, 'session'],
        ['session.message', { from: 'remote', text: 'hello' }, 'session'],
        ['session.kill', {}, 'session'],
        ['session.forget', {}, 'session'],
        ['session.forget', { confirmToken: 'a-token' }, 'session'],
        ['session.update', { name: 'renamed' }, 'session'],
        ['session.update', { pinned: true }, 'session'],
        ['session.ack', {}, 'session'],
        ['session.adopt', { cols: 80, rows: 24 }, 'session'],
        ['session.eject', { prompt: 'carry on' }, 'session'],
        ['session.resumeCommand', {}, 'session'],
        ['session.tap', {}, 'session'],
        ['session.resize', { cols: 80, rows: 24 }, 'session'],
        ['session.detach', {}, 'session'],
        ['message.ack', { message: 'a-message' }, 'session'],
        ['events.read', { waitMs: 0 }, 'session'],
        ['session.spawn', { cwd: '/tmp', target: 'local' }, 'parent'],
      ] as const
    ).map(([method, params, key]) => [method, params, kind.label, key, kind] as const),
  ),
)(
  'it answers %s with %j for %s as for a session that does not exist',
  async (method, params, _label, key, kind) => {
    await using daemon = await setupTest(SPLIT_CONFIG);

    const [rootTarget = 'local', ...childTargets] = kind.targets;

    const root = await daemon.spawnOn(rootTarget);

    const tree = [root];

    for (const target of childTargets) {
      const child = await daemon.spawnOn(target, root);

      tree.push(child);
    }

    const hidden = tree[kind.hidden];

    if (hidden === undefined) {
      throw new Error('the kind addresses no session of its tree');
    }

    const missing = randomUUID();

    // The hidden session has a trail of its own, so a read that reached it
    // would differ.
    await daemon.sendHookEvent(hidden);

    await waitFor(async () => {
      const owner = await daemon.client.sendRequest('events.read', { session: hidden, waitMs: 0 });

      expect(JSON.stringify(owner)).toContain(hidden);
    });

    const answered = await readAnswer(
      () => daemon.client.sendRequest(method, { ...params, [key]: hidden }, 'narrow'),
      hidden,
    );

    const unknown = await readAnswer(
      () => daemon.client.sendRequest(method, { ...params, [key]: missing }, 'narrow'),
      missing,
    );

    const listed = await daemon.client.sendRequest('session.list');

    expect(answered).toStrictEqual(unknown);

    expect(listed).toStrictEqual({
      sessions: expect.toIncludeSamePartialMembers(
        tree.map((id) => ({ id, name: 'tmp', alive: true, pinned: false })),
      ),
    });

    expect(daemon.harnesses).toStrictEqual(kind.targets);
  },
);

test('it answers permission.respond for a request of a session outside the principal as for an unknown request', async () => {
  await using daemon = await setupTest(SPLIT_CONFIG);

  const events: EventMsg[] = [];

  daemon.client.onEvent = (event) => {
    events.push(event);
  };

  const hidden = await daemon.spawnOn('box');

  await daemon.sendHookEvent(hidden, 'Notification');

  await waitFor(() => {
    expect(events).toPartiallyContain({ ev: 'PermissionRequested', s: hidden });
  });

  const requested = events.find((event) => event.ev === 'PermissionRequested');

  if (requested === undefined || typeof requested['request'] !== 'string') {
    throw new Error('the owner saw no permission request');
  }

  const request = requested['request'];
  const missing = randomUUID();

  const answered = await readAnswer(
    () => daemon.client.sendRequest('permission.respond', { request, decision: 'allow' }, 'narrow'),
    request,
  );

  const unknown = await readAnswer(
    () =>
      daemon.client.sendRequest(
        'permission.respond',
        { request: missing, decision: 'allow' },
        'narrow',
      ),
    missing,
  );

  expect(answered).toStrictEqual(unknown);
});

test('it refuses a principal a workspace spawn on a target it may not use for the target alone', async () => {
  await using daemon = await setupTest(SPLIT_CONFIG);

  const refused = daemon.client.sendRequest(
    'session.spawn',
    { cwd: '/tmp', target: 'box', workspace: { kind: 'path', path: '/tmp' } },
    'narrow',
  );

  expect(refused).rejects.toMatchObject({ code: 'target_forbidden', data: { target: 'box' } });

  await refused.catch(() => null);

  expect(daemon.harnesses).toBeEmpty();
});

test('it lists a principal only the directories of spawns on targets it may use', async () => {
  await using daemon = await setupTest(SPLIT_CONFIG);

  await daemon.client.sendRequest('session.spawn', { cwd: '/', target: 'box' });
  await daemon.client.sendRequest('session.spawn', { cwd: '/tmp', target: 'local' });

  await waitFor(async () => {
    const owner = await daemon.client.sendRequest('dirs.list');

    expect(owner).toStrictEqual({ dirs: ['/tmp', '/'] });
  });

  const listed = await daemon.client.sendRequest('dirs.list', {}, 'narrow');

  expect(listed).toStrictEqual({ dirs: ['/tmp'] });
});

test('it lists a principal only the fleet entries of sessions on targets it may use', async () => {
  await using daemon = await setupTest(SPLIT_CONFIG);

  const shown = await daemon.spawnOn('local');
  const hidden = await daemon.spawnOn('box');

  await waitFor(async () => {
    const owner = await daemon.client.sendRequest('fleet.list');

    expect(owner).toMatchObject({
      fleet: expect.toIncludeSameMembers([
        expect.objectContaining({ sessionID: shown }),
        expect.objectContaining({ sessionID: hidden }),
      ]),
    });
  });

  const listed = await daemon.client.sendRequest('fleet.list', {}, 'narrow');

  expect(listed).toStrictEqual({ fleet: [expect.objectContaining({ sessionID: shown })] });
});

test('it keeps the events and messages of a hidden session from a principal whose exited session holds the same agent session id', async () => {
  await using daemon = await setupTest(SPLIT_CONFIG);

  const agentSessionID = `a-${randomUUID()}`;

  const earlier = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    target: 'local',
    resume: agentSessionID,
  });

  await daemon.client.sendRequest('session.kill', {
    session: getRecord(earlier, 'session')['id'],
  });

  const moved = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    target: 'box',
    resume: agentSessionID,
  });

  const hidden = String(getRecord(moved, 'session')['id']);

  await daemon.sendHookEvent(hidden, 'Notification', {
    session_id: agentSessionID,
    message: 'box-only detail',
  });

  const sent = await daemon.client.sendRequest('session.message', {
    session: hidden,
    from: 'owner',
    text: 'box secret message',
  });

  await waitFor(async () => {
    const owner = await daemon.client.sendRequest('events.read', { waitMs: 0 });

    expect(JSON.stringify(owner)).toContain('box secret message');
  });

  const read = await daemon.client.sendRequest('events.read', { waitMs: 0 }, 'narrow');

  const answered = await readAnswer(
    () => daemon.client.sendRequest('message.get', { message: sent['message'] }, 'narrow'),
    String(sent['message']),
  );

  const unknown = await readAnswer(
    () => daemon.client.sendRequest('message.get', { message: 'no-such-message' }, 'narrow'),
    'no-such-message',
  );

  expect(read).toStrictEqual({ events: [], more: false, cursor: expect.anything() });
  expect(answered).toStrictEqual(unknown);
});

test('it keeps the events and messages of a hidden session from a principal whose live session resumes the same agent session', async () => {
  await using daemon = await setupTest(SPLIT_CONFIG);

  const agentSessionID = `a-${randomUUID()}`;

  const moved = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    target: 'box',
    resume: agentSessionID,
  });

  const hidden = String(getRecord(moved, 'session')['id']);

  const own = await daemon.client.sendRequest(
    'session.spawn',
    { cwd: '/tmp', target: 'local', resume: agentSessionID },
    'narrow',
  );

  const shown = String(getRecord(own, 'session')['id']);

  await daemon.sendHookEvent(hidden, 'Notification', {
    session_id: agentSessionID,
    message: 'box-only detail',
  });

  const sent = await daemon.client.sendRequest('session.message', {
    session: hidden,
    from: 'owner',
    text: 'box secret message',
  });

  await waitFor(async () => {
    const owner = await daemon.client.sendRequest('events.read', { waitMs: 0 });

    expect(JSON.stringify(owner)).toContain('box secret message');
  });

  const all = await daemon.client.sendRequest('events.read', { waitMs: 0 }, 'narrow');

  const filtered = await daemon.client.sendRequest(
    'events.read',
    { session: shown, waitMs: 0 },
    'narrow',
  );

  const answered = await readAnswer(
    () => daemon.client.sendRequest('message.get', { message: sent['message'] }, 'narrow'),
    String(sent['message']),
  );

  const unknown = await readAnswer(
    () => daemon.client.sendRequest('message.get', { message: 'no-such-message' }, 'narrow'),
    'no-such-message',
  );

  const got = await daemon.client.sendRequest('session.get', { session: shown }, 'narrow');

  expect(JSON.stringify(all)).not.toInclude('box');
  expect(JSON.stringify(all)).not.toInclude(hidden);
  expect(JSON.stringify(filtered)).not.toInclude('box');
  expect(answered).toStrictEqual(unknown);
  expect(got['lastActivityAt']).toBe(getRecord(own, 'session')['createdAt']);
});

test('it keeps the activity of a forgotten hidden session out of a principal session that shares its agent session id', async () => {
  await using daemon = await setupTest(SPLIT_CONFIG);

  const agentSessionID = `a-${randomUUID()}`;

  const earlier = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    target: 'local',
    resume: agentSessionID,
  });

  const shown = String(getRecord(earlier, 'session')['id']);

  await daemon.client.sendRequest('session.kill', { session: shown });

  const moved = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    target: 'box',
    resume: agentSessionID,
  });

  const hidden = String(getRecord(moved, 'session')['id']);

  const before = await daemon.client.sendRequest('session.get', { session: shown }, 'narrow');

  // The trail stores times to the millisecond, so the hidden session's
  // event lands at a later time than anything the shown session holds.
  await Bun.sleep(20);
  await daemon.sendHookEvent(hidden, 'Notification', { session_id: agentSessionID });

  await waitFor(async () => {
    const owner = await daemon.client.sendRequest('events.read', { waitMs: 0 });

    expect(JSON.stringify(owner)).toContain(hidden);
  });

  await daemon.client.sendRequest('session.kill', { session: hidden });
  await daemon.client.sendRequest('session.kill', { session: hidden });

  const after = await daemon.client.sendRequest('session.get', { session: shown }, 'narrow');

  expect(after['lastActivityAt']).toBe(before['lastActivityAt']);
});

test.each([
  ['a parent whose sub-session is on a target outside the principal', ['local', 'box']],
  ['a sub-session whose parent is on a target outside the principal', ['box', 'local']],
])(
  'it leaves the whole tree of %s out of the lists and the trail',
  async (_label, [rootTarget = 'local', childTarget = 'local']) => {
    await using daemon = await setupTest(SPLIT_CONFIG);

    const shown = await daemon.spawnOn('local');
    const root = await daemon.spawnOn(rootTarget);
    const child = await daemon.spawnOn(childTarget, root);

    await daemon.sendHookEvent(root);
    await daemon.sendHookEvent(child);
    await daemon.sendHookEvent(shown);

    await waitFor(async () => {
      const owner = await daemon.client.sendRequest('events.read', { waitMs: 0 });
      const fleet = await daemon.client.sendRequest('fleet.list');

      expect(JSON.stringify(owner)).toIncludeMultiple([root, child, shown]);
      expect(getRecord(fleet, 'fleet')).toHaveLength(3);
    });

    const listed = await daemon.client.sendRequest('session.list', {}, 'narrow');
    const fleet = await daemon.client.sendRequest('fleet.list', {}, 'narrow');
    const read = await daemon.client.sendRequest('events.read', { waitMs: 0 }, 'narrow');

    expect(listed).toStrictEqual({ sessions: [expect.objectContaining({ id: shown })] });
    expect(fleet).toStrictEqual({ fleet: [expect.objectContaining({ sessionID: shown })] });
    expect(JSON.stringify(read)).toInclude(shown);
    expect(JSON.stringify([listed, fleet, read])).not.toInclude(root);
    expect(JSON.stringify([listed, fleet, read])).not.toInclude(child);
  },
);

test.each([
  ['a parent whose sub-session is on a target outside the principal', ['local', 'box']],
  ['a sub-session whose parent is on a target outside the principal', ['box', 'local']],
])(
  'it pushes a principal connection no event of the tree of %s',
  async (_label, [rootTarget = 'local', childTarget = 'local']) => {
    await using daemon = await setupTest(SPLIT_CONFIG);

    const root = await daemon.spawnOn(rootTarget);
    const child = await daemon.spawnOn(childTarget, root);
    const client = await daemon.openClientAs('narrow');

    const events: EventMsg[] = [];

    client.onEvent = (event) => {
      events.push(event);
    };

    const shown = await daemon.spawnOn('local');

    await daemon.sendHookEvent(root, 'Notification');
    await daemon.sendHookEvent(child, 'Notification');
    await daemon.client.sendRequest('session.update', { session: root, name: 'renamed' });
    await daemon.client.sendRequest('session.kill', { session: root });
    await daemon.client.sendRequest('session.kill', { session: root });
    await daemon.client.sendRequest('session.kill', { session: shown });
    await daemon.client.sendRequest('session.kill', { session: shown });

    await waitFor(() => {
      expect(events).toPartiallyContain({ ev: 'SessionRemoved', s: shown });
    });

    expect(events).toSatisfyAny(
      (event: EventMsg) =>
        event.ev === 'SessionAdded' &&
        isRecord(event['session']) &&
        event['session']['id'] === shown,
    );

    expect(JSON.stringify(events)).not.toInclude(root);
    expect(JSON.stringify(events)).not.toInclude(child);
  },
);

test('it shows a principal a parent leaving when an out-of-reach sub-session joins it as when the owner forgets it', async () => {
  await using joined = await setupTest(SPLIT_CONFIG);
  await using forgot = await setupTest(SPLIT_CONFIG);

  const joinedParent = await joined.spawnOn('local');
  const forgotParent = await forgot.spawnOn('local');

  await forgot.client.sendRequest('session.kill', { session: forgotParent });

  const joinedClient = await joined.openClientAs('narrow');
  const forgotClient = await forgot.openClientAs('narrow');

  const joinedEvents: EventMsg[] = [];
  const forgotEvents: EventMsg[] = [];

  joinedClient.onEvent = (event) => {
    joinedEvents.push(event);
  };

  forgotClient.onEvent = (event) => {
    forgotEvents.push(event);
  };

  const child = await joined.spawnOn('box', joinedParent);

  await forgot.client.sendRequest('session.forget', { session: forgotParent });

  await waitFor(() => {
    expect(joinedEvents).toPartiallyContain({ ev: 'SessionRemoved' });
    expect(forgotEvents).toPartiallyContain({ ev: 'SessionRemoved' });
  });

  await waitFor(async () => {
    const fleet = await forgot.client.sendRequest('fleet.list');

    expect(fleet).toStrictEqual({ fleet: [] });
  });

  const joinedSeen = {
    events: joinedEvents,
    sessions: await joinedClient.sendRequest('session.list'),
    fleet: await joinedClient.sendRequest('fleet.list'),
  };

  const forgotSeen = {
    events: forgotEvents,
    sessions: await forgotClient.sendRequest('session.list'),
    fleet: await forgotClient.sendRequest('fleet.list'),
  };

  expect(JSON.stringify(forgotSeen).replaceAll(forgotParent, '<parent>')).toBe(
    JSON.stringify(joinedSeen).replaceAll(joinedParent, '<parent>'),
  );

  expect(forgotSeen).toStrictEqual({
    events: [{ v: PROTOCOL_V, ev: 'SessionRemoved', s: forgotParent }],
    sessions: { sessions: [] },
    fleet: { fleet: [] },
  });

  expect(JSON.stringify(joinedSeen)).not.toInclude(child);
});

test('it pushes a principal that sees the whole tree only the removal of a forgotten parent', async () => {
  await using daemon = await setupTest(SPLIT_CONFIG);

  const parent = await daemon.spawnOn('local');
  const child = await daemon.spawnOn('box', parent);
  const client = await daemon.openClientAs('wide');

  const events: EventMsg[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await daemon.client.sendRequest('session.forget', { session: parent });

  const listed = await client.sendRequest('session.list');

  await waitFor(() => {
    expect(events).toPartiallyContain({ ev: 'SessionRemoved', s: parent });
  });

  expect(events.filter((event) => event.ev === 'SessionRemoved')).toStrictEqual([
    { v: PROTOCOL_V, ev: 'SessionRemoved', s: parent },
  ]);

  expect(events.filter((event) => event.ev === 'SessionAdded')).toBeEmpty();
  expect(listed).toMatchObject({ sessions: [{ id: child, alive: true }] });
  expect(JSON.stringify(listed)).not.toInclude(parent);
});

test('it takes the inbox tap from a principal connection whose tapped session leaves its view', async () => {
  await using daemon = await setupTest(SPLIT_CONFIG);

  const parent = await daemon.spawnOn('local');
  const client = await daemon.openClientAs('narrow');

  const events: EventMsg[] = [];
  const ownerEvents: EventMsg[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  daemon.client.onEvent = (event) => {
    ownerEvents.push(event);
  };

  await client.sendRequest('session.tap', { session: parent });

  const child = await daemon.spawnOn('box', parent);

  await waitFor(() => {
    expect(events).toPartiallyContain({ ev: 'SessionRemoved', s: parent });
  });

  await daemon.client.sendRequest('session.forget', { session: child });

  await waitFor(() => {
    expect(events).toPartiallyContain({ ev: 'SessionAdded' });
  });

  await daemon.client.sendRequest('session.message', {
    session: parent,
    from: 'owner',
    text: 'for the tap',
  });

  await daemon.client.sendRequest('session.tap', { session: parent });

  await waitFor(() => {
    expect(ownerEvents).toPartiallyContain({ ev: 'InboxMessage', text: 'for the tap' });
  });

  expect(events).not.toPartiallyContain({ ev: 'InboxMessage' });
});

test('it hides from a principal a restored sub-session of a hidden parent', async () => {
  await using daemon = await setupTest(SPLIT_CONFIG);

  const hiddenParent = await daemon.spawnOn('box');
  const hiddenChild = await daemon.spawnOn('local', hiddenParent);
  const shown = await daemon.spawnOn('local');

  await daemon.restart(SPLIT_CONFIG);
  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const owner = await daemon.client.sendRequest('session.list');
  const listed = await daemon.client.sendRequest('session.list', {}, 'narrow');
  const fleet = await daemon.client.sendRequest('fleet.list', {}, 'narrow');

  const sessions: unknown = listed['sessions'];
  const entries: unknown = fleet['fleet'];

  if (!Array.isArray(sessions) || !Array.isArray(entries)) {
    throw new TypeError('a list answered something other than an array');
  }

  expect(owner).toMatchObject({
    sessions: expect.toIncludeAllPartialMembers([{ id: hiddenChild, parent: hiddenParent }]),
  });

  expect(sessions.filter((x) => isRecord(x)).map((x) => x['id'])).toStrictEqual([shown]);
  expect(entries.filter((x) => isRecord(x)).map((x) => x['sessionID'])).toStrictEqual([shown]);
});

test('it kills only the sub-sessions a principal could see when the kill began', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();

  await using daemon = await setupTest(SPLIT_CONFIG, {
    local: {
      capabilities: { suspend: true },
      suspendHost: async () => {
        entered.resolve();

        await release.promise;
      },
    },
  });

  const parent = await daemon.spawnOn('local');

  const killed = daemon.client.sendRequest('session.kill', { session: parent }, 'narrow');

  await entered.promise;

  const child = await daemon.spawnOn('box', parent);

  release.resolve();

  await killed;

  const listed = await daemon.client.sendRequest('session.list');

  expect(listed).toMatchObject({
    sessions: expect.toIncludeAllPartialMembers([
      { id: parent, alive: false },
      { id: child, alive: true, parent },
    ]),
  });
});

test('it spawns a principal that may see the parent beside the sub-session it asks for', async () => {
  await using daemon = await setupTest(SPLIT_CONFIG);

  const parent = await daemon.spawnOn('box');
  const child = await daemon.spawnOn('local', parent);

  const spawned = await daemon.client.sendRequest(
    'session.spawn',
    { cwd: '/tmp', target: 'local', parent: child, resume: `a-${randomUUID()}` },
    'wide',
  );

  expect(getRecord(spawned, 'session')['parent']).toBe(parent);
});

test('it lets a principal forget a session on a target it may use', async () => {
  await using daemon = await setupTest(SPLIT_CONFIG);

  const shown = await daemon.spawnOn('local');
  const forgotten = await daemon.client.sendRequest('session.forget', { session: shown }, 'narrow');

  expect(forgotten).toStrictEqual({ forgotten: true, destroyed: false });
  expect(daemon.client.sendRequest('session.list')).resolves.toStrictEqual({ sessions: [] });
});

test('it answers a forget of a dead session with a dead sub-session out of reach as for a session that does not exist, forgetting nothing', async () => {
  await using daemon = await setupTest(SPLIT_CONFIG);

  const parent = await daemon.spawnOn('local');
  const child = await daemon.spawnOn('box', parent);

  const missing = randomUUID();

  await daemon.client.sendRequest('session.kill', { session: parent });

  const answered = await readAnswer(
    () => daemon.client.sendRequest('session.forget', { session: parent }, 'narrow'),
    parent,
  );

  const unknown = await readAnswer(
    () => daemon.client.sendRequest('session.forget', { session: missing }, 'narrow'),
    missing,
  );

  const listed = await daemon.client.sendRequest('session.list');

  expect(answered).toStrictEqual(unknown);

  expect(listed).toMatchObject({
    sessions: [
      { id: parent, alive: false },
      { id: child, alive: false },
    ],
  });
});

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

test('it answers a report of a session outside the principal as a report that does not exist', async () => {
  await using daemon = await setupTest({
    targets: { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
    principals: { 'client-a': { targets: ['local'] } },
  });

  const hidden = await daemon.spawnOn('box');

  await daemon.sendNote(hidden, 'secret plan');

  const event = await waitFor(async () => {
    const owner = await daemon.client.sendRequest('events.read', { waitMs: 0 });

    const first: unknown = Array.isArray(owner['events']) ? owner['events'][0] : undefined;

    if (!isRecord(first)) {
      throw new TypeError('no event yet');
    }

    return first;
  });

  const cursor = String(event['cursor']);
  const missing = encodeCursor({ kind: 'events', id: 999_999 });

  const owner = await daemon.client.sendRequest('report.get', { report: cursor });

  const answered = await readAnswer(
    () => daemon.client.sendRequest('report.get', { report: cursor }, 'client-a'),
    cursor,
  );

  const unknown = await readAnswer(
    () => daemon.client.sendRequest('report.get', { report: missing }, 'client-a'),
    missing,
  );

  expect(owner).toMatchObject({ session: hidden, text: 'secret plan' });
  expect(answered).toStrictEqual(unknown);
});

test('it gives a principal the report of a session it may see', async () => {
  await using daemon = await setupTest({
    targets: { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
    principals: { 'client-a': { targets: ['local'] } },
  });

  const shown = await daemon.spawnOn('local');

  await daemon.sendNote(shown, 'open plan');

  const event = await waitFor(async () => {
    const read = await daemon.client.sendRequest('events.read', { waitMs: 0 }, 'client-a');

    const first: unknown = Array.isArray(read['events']) ? read['events'][0] : undefined;

    if (!isRecord(first)) {
      throw new TypeError('no event yet');
    }

    return first;
  });

  const report = await daemon.client.sendRequest(
    'report.get',
    { report: event['cursor'] },
    'client-a',
  );

  expect(report).toMatchObject({ session: shown, text: 'open plan', complete: true });
});

test('it names a report by the session that sent it, never a hidden session that resumes the same agent session', async () => {
  await using daemon = await setupTest(SPLIT_CONFIG);

  const agentSessionID = `a-${randomUUID()}`;

  const moved = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    target: 'box',
    resume: agentSessionID,
  });

  const hidden = String(getRecord(moved, 'session')['id']);

  const own = await daemon.client.sendRequest(
    'session.spawn',
    { cwd: '/tmp', target: 'local', resume: agentSessionID },
    'narrow',
  );

  const shown = String(getRecord(own, 'session')['id']);

  await daemon.sendNote(shown, 'open plan');

  const event = await waitFor(async () => {
    const read = await daemon.client.sendRequest('events.read', { waitMs: 0 }, 'narrow');

    const first: unknown = Array.isArray(read['events']) ? read['events'][0] : undefined;

    if (!isRecord(first)) {
      throw new TypeError('no event yet');
    }

    return first;
  });

  const report = await daemon.client.sendRequest(
    'report.get',
    { report: event['cursor'] },
    'narrow',
  );

  expect(report).toMatchObject({ session: shown, text: 'open plan' });
  expect(JSON.stringify(report)).not.toInclude(hidden);
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

test('it answers message.get for a message of a session outside the principal as for an unknown message', async () => {
  await using daemon = await setupTest({
    targets: { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
    principals: { 'client-a': { targets: ['local'] } },
  });

  const hidden = await daemon.spawnOn('box');

  const sent = await daemon.client.sendRequest('session.message', {
    session: hidden,
    from: 'owner',
    text: 'hello',
  });

  const messageID = String(sent['message']);
  const missing = `m-${randomUUID()}`;

  const owner = await daemon.client.sendRequest('message.get', { message: messageID });

  const answered = await readAnswer(
    () => daemon.client.sendRequest('message.get', { message: messageID }, 'client-a'),
    messageID,
  );

  const unknown = await readAnswer(
    () => daemon.client.sendRequest('message.get', { message: missing }, 'client-a'),
    missing,
  );

  expect(owner).toMatchObject({ message: messageID, session: hidden });
  expect(answered).toStrictEqual(unknown);
});

test("it holds each principal's idempotency keys apart and checks each payload within them", async () => {
  await using daemon = await setupTest({});

  const spawn = (principal: string, cwd: string) =>
    daemon.client.sendRequest('session.spawn', { cwd, idempotencyKey: 'k-1' }, principal);

  const first = await spawn('client-a', '/tmp');
  const other = await spawn('client-b', '/tmp');
  const retried = await spawn('client-a', '/tmp');

  expect(spawn('client-a', '/')).rejects.toMatchObject({ code: 'idempotency_conflict' });

  await daemon.client.sendRequest('daemon.ping');

  expect(getRecord(other, 'session')['id']).not.toBe(getRecord(first, 'session')['id']);
  expect(getRecord(retried, 'session')['id']).toBe(getRecord(first, 'session')['id']);
  expect(daemon.harnesses).toStrictEqual(['local', 'local']);
});

test("it keeps a principal connection out of another principal's idempotency keys", async () => {
  await using daemon = await setupTest({});

  const owned = await daemon.client.sendRequest(
    'session.spawn',
    { cwd: '/tmp', idempotencyKey: 'k-1' },
    'client-b',
  );

  const client = await daemon.openClientAs('client-a');

  const reached = await client.sendRequest(
    'session.spawn',
    { cwd: '/tmp', idempotencyKey: 'k-1' },
    'client-b',
  );

  expect(getRecord(reached, 'session')['id']).not.toBe(getRecord(owned, 'session')['id']);
  expect(daemon.harnesses).toStrictEqual(['local', 'local']);
});

// The local-only principal, a `box` target it may not use, and an owner
// that may use both.
const SPLIT_CONFIG: RawConfig = {
  targets: { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
  principals: { narrow: { targets: ['local'] }, wide: { targets: ['local', 'box'] } },
};

test('it answers a kill of a session with a sub-session out of reach as for a session that does not exist, killing nothing', async () => {
  await using daemon = await setupTest(SPLIT_CONFIG);

  const parent = await daemon.spawnOn('local');
  const child = await daemon.spawnOn('box', parent);

  const missing = randomUUID();

  const answered = await readAnswer(
    () => daemon.client.sendRequest('session.kill', { session: parent }, 'narrow'),
    parent,
  );

  const unknown = await readAnswer(
    () => daemon.client.sendRequest('session.kill', { session: missing }, 'narrow'),
    missing,
  );

  const listed = await daemon.client.sendRequest('session.list');

  expect(answered).toStrictEqual(unknown);

  expect(listed).toMatchObject({
    sessions: [
      { id: parent, alive: true },
      { id: child, alive: true },
    ],
  });
});

test.each([
  ['the owner', undefined],
  ['a principal that may use every target in it', 'wide'],
])('it lets %s kill a session together with its sub-sessions', async (_label, principal) => {
  await using daemon = await setupTest(SPLIT_CONFIG);

  const parent = await daemon.spawnOn('local');
  const child = await daemon.spawnOn('box', parent);

  await daemon.client.sendRequest('session.kill', { session: parent }, principal);

  const listed = await daemon.client.sendRequest('session.list');

  expect(listed).toMatchObject({
    sessions: [
      { id: parent, alive: false },
      { id: child, alive: false },
    ],
  });
});

test('it answers a second kill of a dead session with a dead sub-session out of reach as for a session that does not exist, removing nothing', async () => {
  await using daemon = await setupTest(SPLIT_CONFIG);

  const parent = await daemon.spawnOn('local');
  const child = await daemon.spawnOn('box', parent);

  await daemon.client.sendRequest('session.kill', { session: parent });

  expect(
    daemon.client.sendRequest('session.kill', { session: parent }, 'narrow'),
  ).rejects.toMatchObject({ code: 'no_such_session' });

  const listed = await daemon.client.sendRequest('session.list');

  expect(listed).toMatchObject({
    sessions: [
      { id: parent, alive: false },
      { id: child, alive: false },
    ],
  });
});

test('it answers a second kill that would move a live sub-session out of reach as for a session that does not exist, moving nothing', async () => {
  await using daemon = await setupTest(SPLIT_CONFIG);

  const parent = await daemon.spawnOn('local');
  const child = await daemon.spawnOn('box', parent);

  await daemon.client.sendRequest('session.kill', { session: parent });
  await daemon.client.sendRequest('session.adopt', { session: child, cols: 80, rows: 24 });

  expect(
    daemon.client.sendRequest('session.kill', { session: parent }, 'narrow'),
  ).rejects.toMatchObject({ code: 'no_such_session' });

  const listed = await daemon.client.sendRequest('session.list');

  expect(listed).toMatchObject({
    sessions: [
      { id: parent, alive: false },
      { id: child, alive: true, parent },
    ],
  });
});

test('it answers a pin or a rename of a session with a sub-session out of reach as for a session that does not exist, changing nothing', async () => {
  await using daemon = await setupTest(SPLIT_CONFIG);

  const parent = await daemon.spawnOn('local');

  await daemon.spawnOn('box', parent);

  expect(
    daemon.client.sendRequest('session.update', { session: parent, pinned: true }, 'narrow'),
  ).rejects.toMatchObject({ code: 'no_such_session' });

  expect(
    daemon.client.sendRequest('session.update', { session: parent, name: 'renamed' }, 'narrow'),
  ).rejects.toMatchObject({ code: 'no_such_session' });

  const listed = await daemon.client.sendRequest('session.list');

  expect(listed).toMatchObject({ sessions: [{ id: parent, name: 'tmp', pinned: false }, {}] });
});

test('it refuses the replay of a held spawn key once the grant no longer reaches its target', async () => {
  await using daemon = await setupTest(SPLIT_CONFIG);

  const spawn = () =>
    daemon.client.sendRequest(
      'session.spawn',
      { cwd: '/tmp', target: 'box', idempotencyKey: 'k-1' },
      'narrow',
    );

  await daemon.client.sendRequest(
    'session.spawn',
    { cwd: '/tmp', target: 'box', idempotencyKey: 'k-1' },
    'wide',
  );

  await daemon.restart({
    targets: SPLIT_CONFIG.targets,
    principals: { narrow: { targets: ['local'] }, wide: { targets: ['local'] } },
  });

  const replayed = await readAnswer(
    () =>
      daemon.client.sendRequest(
        'session.spawn',
        { cwd: '/tmp', target: 'box', idempotencyKey: 'k-1' },
        'wide',
      ),
    'k-1',
  );

  const fresh = await readAnswer(spawn, 'k-1');

  expect(replayed).toStrictEqual(fresh);
  expect(replayed).toMatchObject({ error: { code: 'target_forbidden' } });
  expect(daemon.harnesses).toStrictEqual(['box']);
});

test("it refuses the replay of a held spawn key once its session's tree leaves the principal's reach", async () => {
  await using daemon = await setupTest(SPLIT_CONFIG);

  const spawn = () =>
    daemon.client.sendRequest(
      'session.spawn',
      { cwd: '/tmp', target: 'local', idempotencyKey: 'k-1' },
      'narrow',
    );

  const spawned = await spawn();

  const parent = String(getRecord(spawned, 'session')['id']);

  const child = await daemon.spawnOn('box', parent);
  const replayed = await readAnswer(spawn, 'k-1');

  expect(replayed).toStrictEqual({
    error: {
      code: 'target_forbidden',
      message: expect.toInclude("'local'"),
      data: { target: 'local' },
    },
  });

  expect(JSON.stringify(replayed)).not.toInclude(parent);
  expect(JSON.stringify(replayed)).not.toInclude(child);
  expect(daemon.harnesses).toStrictEqual(['local', 'box']);
});

test("it answers a principal's long poll on a session whose tree leaves its reach as a poll on a session that never existed", async () => {
  await using daemon = await setupTest(SPLIT_CONFIG);

  const parent = await daemon.spawnOn('local');

  const missing = randomUUID();

  await daemon.client.sendRequest('session.tap', { session: parent });

  const first = await daemon.client.sendRequest(
    'events.read',
    { session: parent, waitMs: 0 },
    'narrow',
  );

  const cursor = first['cursor'];

  const poll = readAnswer(
    () =>
      daemon.client.sendRequest('events.read', { session: parent, cursor, waitMs: 1000 }, 'narrow'),
    parent,
  );

  // No signal shows the poll waiting on the trail; this waits out its
  // first read so the poll blocks before the sub-session joins.
  await Bun.sleep(100);

  const pending = Bun.peek.status(poll);

  await daemon.spawnOn('box', parent);

  await daemon.client.sendRequest('session.message', {
    session: parent,
    from: 'owner',
    text: 'hidden message',
  });

  const answered = await poll;

  const unknown = await readAnswer(
    () =>
      daemon.client.sendRequest('events.read', { session: missing, cursor, waitMs: 0 }, 'narrow'),
    missing,
  );

  expect(pending).toBe('pending');
  expect(answered).toStrictEqual(unknown);
  expect(JSON.stringify(answered)).not.toInclude('hidden message');
});

test("it answers a principal's long poll on a message whose session's tree leaves its reach as a poll on an unknown message", async () => {
  await using daemon = await setupTest(SPLIT_CONFIG);

  const parent = await daemon.spawnOn('local');

  await daemon.client.sendRequest('session.tap', { session: parent });

  const sent = await daemon.client.sendRequest('session.message', {
    session: parent,
    from: 'owner',
    text: 'hidden message',
  });

  const message = String(sent['message']);

  const poll = readAnswer(
    () => daemon.client.sendRequest('message.get', { message, waitMs: 1000 }, 'narrow'),
    message,
  );

  // No signal shows the poll waiting on the message; this waits out its
  // first read so the poll blocks before the sub-session joins.
  await Bun.sleep(100);

  const pending = Bun.peek.status(poll);

  await daemon.spawnOn('box', parent);
  await daemon.client.sendRequest('message.ack', { session: parent, message });

  const answered = await poll;

  const unknown = await readAnswer(
    () =>
      daemon.client.sendRequest('message.get', { message: 'no-such-message', waitMs: 0 }, 'narrow'),
    'no-such-message',
  );

  expect(pending).toBe('pending');
  expect(answered).toStrictEqual(unknown);
  expect(JSON.stringify(answered)).not.toInclude('hidden message');
});

test('it answers the replay of a held spawn key with its session while the grant still reaches it', async () => {
  await using daemon = await setupTest(SPLIT_CONFIG);

  const spawn = () =>
    daemon.client.sendRequest(
      'session.spawn',
      { cwd: '/tmp', target: 'box', idempotencyKey: 'k-1' },
      'wide',
    );

  const first = await spawn();

  await daemon.restart(SPLIT_CONFIG);

  const replayed = await spawn();

  expect(getRecord(replayed, 'session')['id']).toBe(getRecord(first, 'session')['id']);
  expect(daemon.harnesses).toStrictEqual(['box']);
});

test("it refuses a narrow connection a spawn on a wider principal's target, with no session and no replay", async () => {
  await using daemon = await setupTest(SPLIT_CONFIG);

  await daemon.client.sendRequest(
    'session.spawn',
    { cwd: '/tmp', target: 'box', idempotencyKey: 'k-1' },
    'wide',
  );

  const client = await daemon.openClientAs('narrow');

  const refused = await readAnswer(
    () =>
      client.sendRequest(
        'session.spawn',
        { cwd: '/tmp', target: 'box', idempotencyKey: 'k-1' },
        'wide',
      ),
    'k-1',
  );

  expect(refused).toStrictEqual({
    error: {
      code: 'target_forbidden',
      message:
        "this client may not use execution target 'box'. Grant it to the client under principals in config.json and restart the daemon",
      data: { target: 'box' },
    },
  });

  expect(daemon.harnesses).toStrictEqual(['box']);
});

test('it runs one spawn for one key on a principal connection, whatever principal each request acts as', async () => {
  await using daemon = await setupTest(SPLIT_CONFIG);

  const client = await daemon.openClientAs('wide');

  const spawn = (as: string) =>
    client.sendRequest(
      'session.spawn',
      { cwd: '/tmp', target: 'local', idempotencyKey: 'k-1' },
      as,
    );

  const first = await spawn('wide');
  const second = await spawn('narrow');

  expect(getRecord(second, 'session')['id']).toBe(getRecord(first, 'session')['id']);
  expect(daemon.harnesses).toStrictEqual(['local']);
});

// Spawns on `box` under a key as a principal granted `box`, then forgets the
// session, so only the held key still holds what the spawn answered.
async function setupForgottenKeyedSpawn(
  send: (
    m: string,
    p: Readonly<Record<string, unknown>>,
    as?: string,
  ) => Promise<Readonly<Record<string, unknown>>>,
) {
  const spawned = await send(
    'session.spawn',
    { cwd: '/tmp', name: 'secret-work', target: 'box', idempotencyKey: 'k-1' },
    'p',
  );

  const id = String(getRecord(spawned, 'session')['id']);

  await send('session.kill', { session: id });
  await send('session.kill', { session: id });

  return id;
}

const BOX_CONFIG: RawConfig = {
  targets: { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
  principals: { p: { targets: ['box'] } },
};

test("it refuses the replay of a forgotten session's spawn key once its target holds another identity", async () => {
  await using daemon = await setupTest(BOX_CONFIG);

  const id = await setupForgottenKeyedSpawn((m, p, as) => daemon.client.sendRequest(m, p, as));

  await daemon.restart({
    targets: { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 3 } },
    principals: BOX_CONFIG.principals,
  });

  const replayed = await readAnswer(
    () =>
      daemon.client.sendRequest(
        'session.spawn',
        { cwd: '/tmp', name: 'secret-work', target: 'box', idempotencyKey: 'k-1' },
        'p',
      ),
    'unused',
  );

  expect(replayed).toStrictEqual({
    error: {
      code: 'target_forbidden',
      message:
        "this client may not use execution target 'box'. Grant it to the client under principals in config.json and restart the daemon",
      data: { target: 'box' },
    },
  });

  expect(JSON.stringify(replayed)).not.toContain(id);
  expect(daemon.harnesses).toStrictEqual(['box']);
});

test("it answers the replay of a forgotten session's spawn key with its session while its target holds the same identity", async () => {
  await using daemon = await setupTest(BOX_CONFIG);

  const id = await setupForgottenKeyedSpawn((m, p, as) => daemon.client.sendRequest(m, p, as));

  await daemon.restart(BOX_CONFIG);

  const replayed = await daemon.client.sendRequest(
    'session.spawn',
    { cwd: '/tmp', name: 'secret-work', target: 'box', idempotencyKey: 'k-1' },
    'p',
  );

  expect(replayed).toMatchObject({ session: { id, name: 'secret-work' } });
  expect(daemon.harnesses).toStrictEqual(['box']);
});

test('it refuses a principal the replay of a held spawn key that records no target, and answers the owner', async () => {
  await using daemon = await setupTest(BOX_CONFIG);

  const id = await setupForgottenKeyedSpawn((m, p, as) => daemon.client.sendRequest(m, p, as));

  const owned = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    target: 'box',
    idempotencyKey: 'k-owner',
  });

  await daemon.restart(BOX_CONFIG, () => {
    const db = new Database(daemon.dbPath);

    db.run('UPDATE idempotency SET effect_target = NULL, effect_target_identity = NULL');
    db.close();
  });

  const replayed = await readAnswer(
    () =>
      daemon.client.sendRequest(
        'session.spawn',
        { cwd: '/tmp', name: 'secret-work', target: 'box', idempotencyKey: 'k-1' },
        'p',
      ),
    'unused',
  );

  const ownerReplayed = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    target: 'box',
    idempotencyKey: 'k-owner',
  });

  expect(replayed).toMatchObject({ error: { code: 'target_forbidden', data: { target: 'box' } } });
  expect(JSON.stringify(replayed)).not.toContain(id);
  expect(getRecord(ownerReplayed, 'session')['id']).toBe(getRecord(owned, 'session')['id']);
  expect(daemon.harnesses).toStrictEqual(['box', 'box']);
});

test('it lists a principal its sessions in the order it gets when no hidden session sits among them', async () => {
  await using mixed = await setupTest(SPLIT_CONFIG);
  await using clean = await setupTest(SPLIT_CONFIG);

  const mixedFirst = await mixed.spawnOn('local');
  const pinnedHidden = await mixed.spawnOn('box');
  const mixedSecond = await mixed.spawnOn('local');
  const needyHidden = await mixed.spawnOn('box');
  const mixedThird = await mixed.spawnOn('local');
  const cleanFirst = await clean.spawnOn('local');
  const cleanSecond = await clean.spawnOn('local');
  const cleanThird = await clean.spawnOn('local');

  await mixed.client.sendRequest('session.update', { session: pinnedHidden, pinned: true });
  await mixed.sendHookEvent(needyHidden, 'Notification');

  await waitFor(async () => {
    const owner = await mixed.client.sendRequest('session.list');

    expect(owner).toMatchObject({
      sessions: expect.toIncludeAllPartialMembers([
        { id: pinnedHidden, pinned: true },
        { id: needyHidden, state: 'needs_you' },
      ]),
    });
  });

  const mixedLabels = new Map([
    [mixedFirst, 'first'],
    [mixedSecond, 'second'],
    [mixedThird, 'third'],
  ]);

  const cleanLabels = new Map([
    [cleanFirst, 'first'],
    [cleanSecond, 'second'],
    [cleanThird, 'third'],
  ]);

  const mixedListed = await mixed.client.sendRequest('session.list', {}, 'narrow');
  const mixedFleet = await mixed.client.sendRequest('fleet.list', {}, 'narrow');
  const cleanListed = await clean.client.sendRequest('session.list', {}, 'narrow');
  const cleanFleet = await clean.client.sendRequest('fleet.list', {}, 'narrow');

  const mixedSessions: unknown = mixedListed['sessions'];
  const mixedEntries: unknown = mixedFleet['fleet'];
  const cleanSessions: unknown = cleanListed['sessions'];
  const cleanEntries: unknown = cleanFleet['fleet'];

  if (
    !Array.isArray(mixedSessions) ||
    !Array.isArray(mixedEntries) ||
    !Array.isArray(cleanSessions) ||
    !Array.isArray(cleanEntries)
  ) {
    throw new TypeError('a list answered something other than an array');
  }

  const mixedOrder = {
    sessions: mixedSessions.filter((x) => isRecord(x)).map((s) => mixedLabels.get(String(s['id']))),
    fleet: mixedEntries
      .filter((x) => isRecord(x))
      .map((e) => mixedLabels.get(String(e['sessionID']))),
  };

  const cleanOrder = {
    sessions: cleanSessions.filter((x) => isRecord(x)).map((s) => cleanLabels.get(String(s['id']))),
    fleet: cleanEntries
      .filter((x) => isRecord(x))
      .map((e) => cleanLabels.get(String(e['sessionID']))),
  };

  expect(cleanOrder).toStrictEqual({
    sessions: expect.toIncludeSameMembers(['first', 'second', 'third']),
    fleet: expect.toIncludeSameMembers(['first', 'second', 'third']),
  });

  expect(mixedOrder).toStrictEqual(cleanOrder);
});
