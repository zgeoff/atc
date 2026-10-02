import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import { waitFor } from '../../test/wait-for';
import { DaemonClient } from '../client/daemon-client';
import { getRecord } from '../shared/get-record';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toSessionID } from '../shared/to-session-id';
import type { FleetEntry } from '../store/fleet-entry';
import { StateStore } from '../store/state-store';
import type { ExecutionTarget } from './build-execution-targets';
import { startDaemon } from './daemon';
import { LocalPTYProvider } from './local-pty-provider';

interface TargetsSetup {
  readonly targets: readonly ExecutionTarget[];
  readonly defaultTarget?: string;

  // Rows the store holds before the daemon starts.
  readonly fleet?: readonly FleetEntry[];
}

// A real daemon with the execution targets the test configures, whose
// sessions idle on a real pseudo-terminal.
async function setupTest(setup: TargetsSetup) {
  const tmp = setupTempDir('atc-daemon-targets-');
  const sockPath = join(tmp.dir, 'daemon.sock');
  const dbPath = join(tmp.dir, 'state.db');

  if (setup.fleet !== undefined) {
    const store = await StateStore.open(dbPath);

    await store.writeFleet(setup.fleet);
    await store.stop();
  }

  const daemon = await startDaemon({
    socketPath: sockPath,
    reporterSocketPath: join(tmp.dir, 'reporter.sock'),
    build: 'atc/test-build',
    adapter: {
      id: 'claude',
      headlessRunner: null,
      screenDetector: null,
      takesMessages: false,
      planSpawn: () => ({ bin: 'sleep', args: ['30'] }),
      normalizeHook: () => ({ kind: 'heartbeat' }),
      loadName: () => Promise.resolve(null),
      canResume: () => true,
      buildResumeCommand: () => null,
    },
    dbPath,
    statusPath: join(tmp.dir, 'status.json'),
    targets: setup.targets,
    ...(setup.defaultTarget === undefined ? {} : { defaultTarget: setup.defaultTarget }),
  });

  const client = await DaemonClient.open(sockPath);

  await client.sendHello('atc/test-build');

  return {
    client,
    async [Symbol.asyncDispose]() {
      client.stop();

      await daemon.stop();

      tmp[Symbol.dispose]();
    },
  };
}

test('it spawns a session on the target the spawn names and records it in the fleet', async () => {
  await using daemon = await setupTest({
    targets: [
      { id: 'local', kind: 'local-pty', options: {}, provider: new LocalPTYProvider() },
      { id: 'box', kind: 'local-pty', options: {}, provider: new LocalPTYProvider() },
    ],
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    target: 'box',
  });

  const session = getRecord(spawned, 'session');

  expect(session['locator']).toMatchObject({ targetID: 'box' });

  await waitFor(async () => {
    const stored = await daemon.client.sendRequest('fleet.list');

    expect(stored).toMatchObject({ fleet: [{ sessionID: session['id'], target: 'box' }] });
  });
});

test('it spawns a session without a target on the local target by default', async () => {
  await using daemon = await setupTest({
    targets: [
      { id: 'local', kind: 'local-pty', options: {}, provider: new LocalPTYProvider() },
      { id: 'box', kind: 'local-pty', options: {}, provider: new LocalPTYProvider() },
    ],
  });

  const spawned = await daemon.client.sendRequest('session.spawn', { cwd: '/tmp' });

  expect(getRecord(spawned, 'session')['locator']).toMatchObject({ targetID: 'local' });
});

test('it refuses a spawn to a target the config does not hold with unknown_target', async () => {
  await using daemon = await setupTest({
    targets: [{ id: 'local', kind: 'local-pty', options: {}, provider: new LocalPTYProvider() }],
  });

  const spawn = daemon.client.sendRequest('session.spawn', { cwd: '/tmp', target: 'nope' });

  expect(spawn).rejects.toMatchObject({ code: 'unknown_target', data: { target: 'nope' } });
  expect(daemon.client.sendRequest('session.list')).resolves.toStrictEqual({ sessions: [] });
});

test('it refuses a spawn to a target this daemon has no provider for with target_unavailable', async () => {
  await using daemon = await setupTest({
    targets: [
      { id: 'local', kind: 'local-pty', options: {}, provider: new LocalPTYProvider() },
      { id: 'box', kind: 'imp', options: {}, provider: null },
    ],
  });

  const spawn = daemon.client.sendRequest('session.spawn', { cwd: '/tmp', target: 'box' });

  expect(spawn).rejects.toMatchObject({
    code: 'target_unavailable',
    data: { target: 'box', provider: 'imp' },
  });

  expect(daemon.client.sendRequest('session.list')).resolves.toStrictEqual({ sessions: [] });
});

test('it spawns a session without a target on the configured default when local is off', async () => {
  await using daemon = await setupTest({
    targets: [{ id: 'box', kind: 'local-pty', options: {}, provider: new LocalPTYProvider() }],
  });

  const spawned = await daemon.client.sendRequest('session.spawn', { cwd: '/tmp' });

  expect(getRecord(spawned, 'session')['locator']).toMatchObject({ targetID: 'box' });
});

test('it refuses a spawn to the local target when local is off', async () => {
  await using daemon = await setupTest({
    targets: [{ id: 'box', kind: 'local-pty', options: {}, provider: new LocalPTYProvider() }],
  });

  const spawn = daemon.client.sendRequest('session.spawn', { cwd: '/tmp', target: 'local' });

  expect(spawn).rejects.toMatchObject({ code: 'unknown_target' });
});

test('it lists each target with its provider, availability, and capabilities', async () => {
  await using daemon = await setupTest({
    targets: [
      { id: 'local', kind: 'local-pty', options: {}, provider: new LocalPTYProvider() },
      { id: 'box', kind: 'imp', options: { image: 'dev' }, provider: null },
    ],
    defaultTarget: 'box',
  });

  const listed = await daemon.client.sendRequest('agents.list');

  expect({
    targets: listed['targets'],
    spawnDefaults: listed['spawnDefaults'],
  }).toStrictEqual({
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: false,
        capabilities: {
          spawn: true,
          attach: true,
          input: true,
          resize: true,
          kill: true,
          transfer: true,
          run: true,
          suspend: false,
          destroy: false,
        },
      },
      {
        id: 'box',
        provider: 'imp',
        available: false,
        default: true,
        capabilities: {
          spawn: false,
          attach: false,
          input: false,
          resize: false,
          kill: false,
          transfer: false,
          run: false,
          suspend: false,
          destroy: false,
        },
      },
    ],
    spawnDefaults: { agent: 'claude', target: 'box' },
  });
});

test('it lists a restored session whose target is gone from the config without reviving it', async () => {
  await using daemon = await setupTest({
    targets: [{ id: 'local', kind: 'local-pty', options: {}, provider: new LocalPTYProvider() }],
    fleet: [
      {
        sessionID: toSessionID('s-box'),
        name: 'remote work',
        cwd: '/tmp',
        agentSessionID: toAgentSessionID('a-box'),
        agent: 'claude',
        target: 'box',
      },
    ],
  });

  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const listed = await daemon.client.sendRequest('session.list');

  expect(listed).toMatchObject({
    sessions: [
      { id: 's-box', lastMsg: "no target 'box'", alive: false, locator: { targetID: 'box' } },
    ],
  });
});

test('it revives a restored session without a target on the local target', async () => {
  await using daemon = await setupTest({
    targets: [{ id: 'local', kind: 'local-pty', options: {}, provider: new LocalPTYProvider() }],
    fleet: [
      {
        sessionID: toSessionID('s-old'),
        name: 'old work',
        cwd: '/tmp',
        agentSessionID: toAgentSessionID('a-old'),
        agent: 'claude',
      },
    ],
  });

  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const listed = await daemon.client.sendRequest('session.list');

  expect(listed).toMatchObject({
    sessions: [{ id: 's-old', alive: true, locator: { targetID: 'local' } }],
  });
});

test('it lists a restored session without a target unrevived when local is off', async () => {
  await using daemon = await setupTest({
    targets: [{ id: 'box', kind: 'local-pty', options: {}, provider: new LocalPTYProvider() }],
    fleet: [
      {
        sessionID: toSessionID('s-old'),
        name: 'old work',
        cwd: '/tmp',
        agentSessionID: toAgentSessionID('a-old'),
        agent: 'claude',
      },
    ],
  });

  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const listed = await daemon.client.sendRequest('session.list');

  expect(listed['sessions']).toStrictEqual([
    expect.objectContaining({ id: 's-old', lastMsg: "no target 'local'", alive: false }),
  ]);
});

test('it refuses to revive a session on a target gone from the config with unknown_target', async () => {
  await using daemon = await setupTest({
    targets: [{ id: 'local', kind: 'local-pty', options: {}, provider: new LocalPTYProvider() }],
    fleet: [
      {
        sessionID: toSessionID('s-box'),
        name: 'remote work',
        cwd: '/tmp',
        agentSessionID: toAgentSessionID('a-box'),
        agent: 'claude',
        target: 'box',
      },
    ],
  });

  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const adopt = daemon.client.sendRequest('session.adopt', {
    session: 's-box',
    cols: 80,
    rows: 24,
  });

  expect(adopt).rejects.toMatchObject({ code: 'unknown_target', data: { target: 'box' } });
});
