import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import { waitFor } from '../../test/wait-for';
import { DaemonClient } from '../client/daemon-client';
import { DaemonError } from '../protocol/daemon-error';
import { encodeCursor } from '../protocol/encode-cursor';
import type { EventMsg } from '../protocol/protocol';
import { collectPrincipals } from '../shared/collect-principals';
import { collectTargets } from '../shared/collect-targets';
import { getRecord } from '../shared/get-record';
import { isRecord } from '../shared/report';
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
 * principal. `restart` stops the daemon and starts it again on the same
 * state with another config, running `whileStopped` in between, and
 * `dbPath` is that state.
 */
async function setupTest(raw: RawConfig) {
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
          capabilities: local.capabilities,
          spawnHarness: (spec) => {
            harnesses.push(target.id);

            return local.spawnHarness(spec);
          },
          transferArchive: local.transferArchive,
          runCommand: local.runCommand,
          suspendHost: local.suspendHost,
          destroyHost: local.destroyHost,
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

test.each([
  ['session.get', {}],
  ['session.read', {}],
  ['session.screen', {}],
  ['session.attach', { cols: 80, rows: 24 }],
  ['session.input', { d: 'go\r' }],
  ['session.submit', { text: 'go' }],
  ['session.message', { from: 'remote', text: 'hello' }],
  ['session.kill', {}],
  ['session.forget', {}],
  ['session.forget', { confirmToken: 'a-token' }],
  ['session.update', { name: 'renamed' }],
  ['session.ack', {}],
  ['session.adopt', { cols: 80, rows: 24 }],
  ['session.eject', { prompt: 'carry on' }],
  ['session.resumeCommand', {}],
  ['session.tap', {}],
  ['session.resize', { cols: 80, rows: 24 }],
  ['session.detach', {}],
  ['message.ack', { message: 'a-message' }],
  ['events.read', { waitMs: 0 }],
])(
  'it answers %s with %j for a session outside the principal as for a session that does not exist',
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

test('it answers a spawn under a parent outside the principal as under a parent that does not exist', async () => {
  await using daemon = await setupTest(SPLIT_CONFIG);

  const hidden = await daemon.spawnOn('box');

  const missing = randomUUID();

  const answered = await readAnswer(
    () =>
      daemon.client.sendRequest(
        'session.spawn',
        { cwd: '/tmp', target: 'local', parent: hidden },
        'narrow',
      ),
    hidden,
  );

  const unknown = await readAnswer(
    () =>
      daemon.client.sendRequest(
        'session.spawn',
        { cwd: '/tmp', target: 'local', parent: missing },
        'narrow',
      ),
    missing,
  );

  expect(answered).toStrictEqual(unknown);
  expect(daemon.harnesses).toStrictEqual(['box']);
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

test('it lists a principal a sub-session of a hidden parent as a top-level session', async () => {
  await using daemon = await setupTest(SPLIT_CONFIG);

  const hiddenParent = await daemon.spawnOn('box');
  const shownChild = await daemon.spawnOn('local', hiddenParent);

  await waitFor(async () => {
    const owner = await daemon.client.sendRequest('fleet.list');

    expect(owner).toMatchObject({
      fleet: expect.toPartiallyContain({ sessionID: shownChild, parent: hiddenParent }),
    });
  });

  const listed = await daemon.client.sendRequest('session.list', {}, 'narrow');
  const fleet = await daemon.client.sendRequest('fleet.list', {}, 'narrow');
  const got = await daemon.client.sendRequest('session.get', { session: shownChild }, 'narrow');

  expect(listed).toMatchObject({ sessions: [{ id: shownChild }] });
  expect(fleet).toMatchObject({ fleet: [{ sessionID: shownChild }] });
  expect(getRecord(got, 'session')).toContainEntry(['id', shownChild]);
  expect(getRecord(got, 'session')).not.toContainKey('parent');
  expect(JSON.stringify([listed, fleet, got])).not.toInclude(hiddenParent);
});

test('it pushes a principal connection a sub-session of a hidden parent as a top-level session', async () => {
  await using daemon = await setupTest(SPLIT_CONFIG);

  const client = await daemon.openClientAs('narrow');

  const events: EventMsg[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  const hiddenParent = await daemon.spawnOn('box');
  const shownChild = await daemon.spawnOn('local', hiddenParent);

  await daemon.client.sendRequest('session.kill', { session: shownChild });

  await waitFor(() => {
    expect(JSON.stringify(events)).toInclude('"lastMsg":"killed"');
  });

  expect(events.map((event) => event.ev)).toContain('SessionAdded');
  expect(JSON.stringify(events)).toInclude(shownChild);
  expect(JSON.stringify(events)).not.toInclude(hiddenParent);
});

test('it spawns a principal top-level when the parent it asks for sits under a hidden parent', async () => {
  await using daemon = await setupTest(SPLIT_CONFIG);

  const hiddenParent = await daemon.spawnOn('box');
  const shownChild = await daemon.spawnOn('local', hiddenParent);

  const spawned = await daemon.client.sendRequest(
    'session.spawn',
    { cwd: '/tmp', target: 'local', parent: shownChild, resume: `a-${randomUUID()}` },
    'narrow',
  );

  const id = getRecord(spawned, 'session')['id'];

  const owner = await daemon.client.sendRequest('session.get', { session: id });

  expect(JSON.stringify(spawned)).not.toInclude(hiddenParent);
  expect(getRecord(spawned, 'session')).not.toContainKey('parent');
  expect(getRecord(owner, 'session')).not.toContainKey('parent');
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

test('it refuses a principal a forget of a session with a sub-session out of reach, forgetting nothing', async () => {
  await using daemon = await setupTest(SPLIT_CONFIG);

  const parent = await daemon.spawnOn('local');
  const child = await daemon.spawnOn('box', parent);

  await daemon.client.sendRequest('session.kill', { session: parent });

  const refused = await readAnswer(
    () => daemon.client.sendRequest('session.forget', { session: parent }, 'narrow'),
    parent,
  );

  const listed = await daemon.client.sendRequest('session.list');

  expect(refused).toStrictEqual({
    error: {
      code: 'target_forbidden',
      message:
        "this client may not forget session '<session>': it has a sub-session on a target this client may not use",
      data: { session: '<session>' },
    },
  });

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

test('it refuses a principal a kill of a session with a sub-session out of reach, killing nothing', async () => {
  await using daemon = await setupTest(SPLIT_CONFIG);

  const parent = await daemon.spawnOn('local');
  const child = await daemon.spawnOn('box', parent);

  const refused = await readAnswer(
    () => daemon.client.sendRequest('session.kill', { session: parent }, 'narrow'),
    parent,
  );

  const listed = await daemon.client.sendRequest('session.list');

  expect(refused).toStrictEqual({
    error: {
      code: 'target_forbidden',
      message:
        "this client may not kill session '<session>': it has a sub-session on a target this client may not use",
      data: { session: '<session>' },
    },
  });

  expect(JSON.stringify(refused)).not.toContain(child);

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

test('it refuses a principal a forget of a dead session with a dead sub-session out of reach, removing nothing', async () => {
  await using daemon = await setupTest(SPLIT_CONFIG);

  const parent = await daemon.spawnOn('local');
  const child = await daemon.spawnOn('box', parent);

  await daemon.client.sendRequest('session.kill', { session: parent });

  expect(
    daemon.client.sendRequest('session.kill', { session: parent }, 'narrow'),
  ).rejects.toMatchObject({ code: 'target_forbidden', data: { session: parent } });

  const listed = await daemon.client.sendRequest('session.list');

  expect(listed).toMatchObject({
    sessions: [
      { id: parent, alive: false },
      { id: child, alive: false },
    ],
  });
});

test('it refuses a principal a forget that would move a live sub-session out of reach, moving nothing', async () => {
  await using daemon = await setupTest(SPLIT_CONFIG);

  const parent = await daemon.spawnOn('local');
  const child = await daemon.spawnOn('box', parent);

  await daemon.client.sendRequest('session.kill', { session: parent });
  await daemon.client.sendRequest('session.adopt', { session: child, cols: 80, rows: 24 });

  expect(
    daemon.client.sendRequest('session.kill', { session: parent }, 'narrow'),
  ).rejects.toMatchObject({ code: 'target_forbidden', data: { session: parent } });

  const listed = await daemon.client.sendRequest('session.list');

  expect(listed).toMatchObject({
    sessions: [
      { id: parent, alive: false },
      { id: child, alive: true, parent },
    ],
  });
});

test('it refuses a principal a pin of a session with a sub-session out of reach, pinning nothing', async () => {
  await using daemon = await setupTest(SPLIT_CONFIG);

  const parent = await daemon.spawnOn('local');

  await daemon.spawnOn('box', parent);

  expect(
    daemon.client.sendRequest('session.update', { session: parent, pinned: true }, 'narrow'),
  ).rejects.toMatchObject({ code: 'target_forbidden', data: { session: parent } });

  await daemon.client.sendRequest('session.update', { session: parent, name: 'renamed' }, 'narrow');

  const listed = await daemon.client.sendRequest('session.list');

  expect(listed).toMatchObject({ sessions: [{ id: parent, name: 'renamed', pinned: false }, {}] });
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
