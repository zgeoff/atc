import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { DaemonClient } from '../client/daemon-client';
import { collectTargets } from '../shared/collect-targets';
import { getRecord } from '../shared/get-record';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toSessionID } from '../shared/to-session-id';
import type { FleetEntry } from '../store/fleet-entry';
import { StateStore } from '../store/state-store';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { waitFor } from '../test-utils/wait-for';
import { buildTargetIdentity } from './build-target-identity';
import { startDaemon } from './daemon';
import { LocalPTYProvider } from './local-pty-provider';

// The `targets` and `defaultTarget` keys of a config.json, raw.
interface RawTargets {
  readonly targets?: unknown;
  readonly defaultTarget?: unknown;
}

/**
 * A real daemon on a state directory that outlives restarts, whose targets
 * come from a raw config through the real parse. A `local-pty` target runs
 * harnesses on a real pseudo-terminal through a provider that counts its
 * spawns, a `no-headless` target's provider can neither start a terminal
 * nor run a headless turn, and any other kind has no provider. The agent's
 * headless runner records each call and finishes the turn on the next tick.
 */
async function setupTest(fleet: readonly FleetEntry[] = []) {
  const tmp = setupTempDir('atc-daemon-targets-');
  const dbPath = join(tmp.dir, 'state.db');

  const local = new LocalPTYProvider();

  const harnesses: string[] = [];
  const runs: string[] = [];
  let stopCurrent: (() => Promise<void>) | null = null;

  if (fleet.length > 0) {
    const store = await StateStore.open(dbPath);

    await store.writeFleet(fleet);
    await store.stop();
  }

  const openDaemon = async (raw: RawTargets) => {
    await stopCurrent?.();

    const parsed = collectTargets(raw.targets, raw.defaultTarget);

    const daemon = await startDaemon({
      socketPath: join(tmp.dir, 'daemon.sock'),
      reporterSocketPath: join(tmp.dir, 'reporter.sock'),
      build: 'atc/test-build',
      adapter: {
        id: 'claude',
        screenDetector: null,
        takesMessages: false,
        headlessRunner: (opts, hooks) => {
          runs.push(opts.prompt);

          setTimeout(() => {
            hooks.onDone('turn finished');
          }, 0);

          return { stop: () => {} };
        },
        planSpawn: () => ({ bin: 'sleep', args: ['30'] }),
        normalizeHook: () => ({ kind: 'heartbeat' }),
        loadName: () => Promise.resolve(null),
        canResume: () => true,
        buildResumeCommand: () => null,
      },
      dbPath,
      statusPath: join(tmp.dir, 'status.json'),
      ejectSettleMs: 0,
      targets: parsed.targets.map((target) => ({
        id: target.id,
        kind: target.provider,
        options: target.options,
        identity: buildTargetIdentity(target.provider, target.options),
        provider:
          target.provider === 'local-pty' || target.provider === 'no-headless'
            ? {
                kind: target.provider,
                remote: false,
                prepareHost: local.prepareHost,
                dispose: local.dispose,
                capabilities: {
                  ...local.capabilities,
                  spawn: target.provider === 'local-pty',
                  headless: target.provider === 'local-pty',
                },
                spawnHarness: (spec) => {
                  harnesses.push(target.id);

                  return local.spawnHarness(spec);
                },
                transferArchive: local.transferArchive,
                runCommand: local.runCommand,
                suspendHost: local.suspendHost,
                destroyHost: local.destroyHost,
              }
            : null,
      })),
      defaultTarget: parsed.defaultTarget,
      targetErrors: parsed.errors,
    });

    const client = await DaemonClient.open(join(tmp.dir, 'daemon.sock'));

    await client.sendHello('atc/test-build');

    stopCurrent = async () => {
      client.stop();

      await daemon.stop();
    };

    return client;
  };

  return {
    harnesses,
    runs,
    openDaemon,
    async [Symbol.asyncDispose]() {
      await stopCurrent?.();

      tmp[Symbol.dispose]();
    },
  };
}

test('it spawns a session on the target the spawn names and records it in the fleet', async () => {
  await using daemon = await setupTest();

  const client = await daemon.openDaemon({
    targets: { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
  });

  const spawned = await client.sendRequest('session.spawn', { cwd: '/tmp', target: 'box' });

  const session = getRecord(spawned, 'session');

  expect(session['locator']).toMatchObject({ targetID: 'box' });
  expect(daemon.harnesses).toStrictEqual(['box']);

  await waitFor(async () => {
    const stored = await client.sendRequest('fleet.list');

    expect(stored).toMatchObject({
      fleet: [
        {
          sessionID: session['id'],
          target: 'box',
          targetIdentity: buildTargetIdentity('local-pty', { size: 2 }),
        },
      ],
    });
  });
});

test('it spawns a session without a target on the local target when the config sets no targets', async () => {
  await using daemon = await setupTest();

  const client = await daemon.openDaemon({});
  const spawned = await client.sendRequest('session.spawn', { cwd: '/tmp' });

  expect(getRecord(spawned, 'session')['locator']).toMatchObject({ targetID: 'local' });
  expect(daemon.harnesses).toStrictEqual(['local']);
});

test('it refuses a spawn to a target the config does not hold with unknown_target', async () => {
  await using daemon = await setupTest();

  const client = await daemon.openDaemon({});

  const spawn = client.sendRequest('session.spawn', { cwd: '/tmp', target: 'nope' });

  expect(spawn).rejects.toMatchObject({ code: 'unknown_target', data: { target: 'nope' } });
  expect(client.sendRequest('session.list')).resolves.toStrictEqual({ sessions: [] });
  expect(daemon.harnesses).toStrictEqual([]);
});

test('it refuses a spawn to a target this daemon has no provider for with target_unavailable', async () => {
  await using daemon = await setupTest();

  const client = await daemon.openDaemon({
    targets: { local: { provider: 'local-pty' }, box: { provider: 'imp' } },
  });

  const spawn = client.sendRequest('session.spawn', { cwd: '/tmp', target: 'box' });

  expect(spawn).rejects.toMatchObject({
    code: 'target_unavailable',
    data: { target: 'box', provider: 'imp' },
  });

  expect(client.sendRequest('session.list')).resolves.toStrictEqual({ sessions: [] });
  expect(daemon.harnesses).toStrictEqual([]);
});

test('it refuses a spawn to the local target when the targets map leaves it out', async () => {
  await using daemon = await setupTest();

  const client = await daemon.openDaemon({ targets: { box: { provider: 'local-pty' } } });

  const spawn = client.sendRequest('session.spawn', { cwd: '/tmp', target: 'local' });

  expect(spawn).rejects.toMatchObject({ code: 'unknown_target' });
  expect(daemon.harnesses).toStrictEqual([]);
});

test('it refuses a spawn without a target, and starts no terminal, for a malformed targets map', async () => {
  await using daemon = await setupTest();

  const client = await daemon.openDaemon({ targets: ['local'] });

  const spawn = client.sendRequest('session.spawn', { cwd: '/tmp' });

  expect(spawn).rejects.toMatchObject({
    code: 'target_config_invalid',
    data: { problem: 'targets must be a non-empty object of named targets' },
  });

  expect(client.sendRequest('session.list')).resolves.toStrictEqual({ sessions: [] });
  expect(daemon.harnesses).toStrictEqual([]);
});

test('it refuses a spawn to local, and starts no terminal, for a malformed targets map', async () => {
  await using daemon = await setupTest();

  const client = await daemon.openDaemon({ targets: 'local' });

  const spawn = client.sendRequest('session.spawn', { cwd: '/tmp', target: 'local' });

  expect(spawn).rejects.toMatchObject({ code: 'target_config_invalid', data: { target: 'local' } });
  expect(daemon.harnesses).toStrictEqual([]);
});

test('it refuses a spawn to a malformed target entry and keeps the well-formed ones working', async () => {
  await using daemon = await setupTest();

  const client = await daemon.openDaemon({
    targets: { local: { provider: 'local-pty' }, box: { image: 'dev' } },
  });

  const refused = client.sendRequest('session.spawn', { cwd: '/tmp', target: 'box' });

  const spawned = await client.sendRequest('session.spawn', { cwd: '/tmp' });

  expect(refused).rejects.toMatchObject({ code: 'target_config_invalid', data: { target: 'box' } });
  expect(getRecord(spawned, 'session')['locator']).toMatchObject({ targetID: 'local' });
  expect(daemon.harnesses).toStrictEqual(['local']);
});

test('it refuses a spawn without a target, and starts no terminal, for an unknown defaultTarget', async () => {
  await using daemon = await setupTest();

  const client = await daemon.openDaemon({
    targets: { local: { provider: 'local-pty' } },
    defaultTarget: 'gone',
  });

  const spawn = client.sendRequest('session.spawn', { cwd: '/tmp' });

  expect(spawn).rejects.toMatchObject({
    code: 'target_config_invalid',
    data: { problem: 'defaultTarget: matches no well-formed target in targets' },
  });

  expect(daemon.harnesses).toStrictEqual([]);
});

test('it lists each target and each config error', async () => {
  await using daemon = await setupTest();

  const client = await daemon.openDaemon({
    targets: { local: { provider: 'local-pty' }, box: { provider: 'imp' }, bad: 3 },
    defaultTarget: 'box',
  });

  const listed = await client.sendRequest('agents.list');

  expect({
    targets: listed['targets'],
    spawnDefaults: listed['spawnDefaults'],
    targetErrors: listed['targetErrors'],
  }).toStrictEqual({
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        identity: buildTargetIdentity('local-pty', {}),
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
          headless: true,
          suspend: false,
          destroy: false,
        },
        brokerAuth: false,
      },
      {
        id: 'box',
        provider: 'imp',
        identity: buildTargetIdentity('imp', {}),
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
          headless: false,
          suspend: false,
          destroy: false,
        },
        brokerAuth: false,
      },
    ],
    spawnDefaults: { agent: 'claude', target: 'box' },
    targetErrors: [
      {
        scope: 'target',
        target: 'bad',
        problem: 'target "bad" must be an object with a non-empty string provider',
      },
    ],
  });
});

test.each([
  ['removed from the config', 'local-pty', { local: { provider: 'local-pty' } }, 'unknown_target'],
  [
    'left without a provider',
    'imp',
    { local: { provider: 'local-pty' }, box: { provider: 'imp' } },
    'target_unavailable',
  ],
  [
    'malformed in the config',
    'local-pty',
    { local: { provider: 'local-pty' }, box: { image: 'dev' } },
    'target_config_invalid',
  ],
])(
  'it refuses input to a restored headless session whose target was %s, without running it',
  async (_label, boundKind, targets, code) => {
    await using daemon = await setupTest([
      {
        sessionID: toSessionID('s-box'),
        name: 'remote work',
        cwd: '/tmp',
        agentSessionID: toAgentSessionID('a-box'),
        agent: 'claude',
        target: 'box',
        targetIdentity: buildTargetIdentity(boundKind, {}),
      },
    ]);

    const client = await daemon.openDaemon({ targets });

    await client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

    const input = client.sendRequest('session.input', { session: 's-box', d: 'go\r' });

    expect(input).rejects.toMatchObject({ code, data: { target: 'box' } });
    expect(daemon.runs).toStrictEqual([]);
    expect(daemon.harnesses).toStrictEqual([]);
  },
);

test('it refuses input to a restored headless session on local once the targets map turns local off', async () => {
  await using daemon = await setupTest([
    {
      sessionID: toSessionID('s-old'),
      name: 'old work',
      cwd: '/tmp',
      agentSessionID: toAgentSessionID('a-old'),
      agent: 'claude',
    },
  ]);

  const client = await daemon.openDaemon({ targets: { box: { provider: 'local-pty' } } });

  await client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const input = client.sendRequest('session.input', { session: 's-old', d: 'go\r' });

  expect(input).rejects.toMatchObject({ code: 'unknown_target', data: { target: 'local' } });
  expect(daemon.runs).toStrictEqual([]);
  expect(daemon.harnesses).toStrictEqual([]);
});

test('it refuses input to a restored headless session whose provider runs no headless turns, without running it', async () => {
  await using daemon = await setupTest([
    {
      sessionID: toSessionID('s-box'),
      name: 'remote work',
      cwd: '/tmp',
      agentSessionID: toAgentSessionID('a-box'),
      agent: 'claude',
      target: 'box',
      targetIdentity: buildTargetIdentity('no-headless', {}),
    },
  ]);

  const client = await daemon.openDaemon({
    targets: { local: { provider: 'local-pty' }, box: { provider: 'no-headless' } },
  });

  await client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const input = client.sendRequest('session.input', { session: 's-box', d: 'go\r' });

  expect(input).rejects.toMatchObject({
    code: 'unsupported_operation',
    data: { provider: 'no-headless', capability: 'headless' },
  });

  expect(daemon.runs).toStrictEqual([]);
});

test('it refuses input to a killed headless session on a working target, without running it', async () => {
  await using daemon = await setupTest([
    {
      sessionID: toSessionID('s-old'),
      name: 'old work',
      cwd: '/tmp',
      agentSessionID: toAgentSessionID('a-old'),
      agent: 'claude',
      exited: true,
    },
  ]);

  const client = await daemon.openDaemon({});

  await client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const input = client.sendRequest('session.input', { session: 's-old', d: 'go\r' });

  expect(input).rejects.toMatchObject({ code: 'session_dead' });
  expect(daemon.runs).toStrictEqual([]);
});

test('it runs a local headless turn through the runner once per request', async () => {
  await using daemon = await setupTest();

  const client = await daemon.openDaemon({});
  const spawned = await client.sendRequest('session.spawn', { cwd: '/tmp', resume: 'a-1' });

  const id = getRecord(spawned, 'session')['id'];

  await client.sendRequest('session.eject', { session: id, prompt: 'carry on' });

  await waitFor(async () => {
    const listed = await client.sendRequest('session.list');

    expect(listed).toMatchObject({ sessions: [{ id, state: 'done' }] });
  });

  await client.sendRequest('session.input', { session: id, d: 'next step\n' });

  await waitFor(async () => {
    const listed = await client.sendRequest('session.list');

    expect(listed).toMatchObject({ sessions: [{ id, lastMsg: 'turn finished' }] });
  });

  expect(daemon.runs).toStrictEqual(['carry on', 'next step']);
});

test.each([
  ['another provider', { provider: 'no-headless' }],
  ['other options', { provider: 'local-pty', image: 'ci' }],
])(
  'it refuses input, resume, and revive for a session whose target name now holds %s',
  async (_label, changed) => {
    await using daemon = await setupTest();

    const first = await daemon.openDaemon({
      targets: { local: { provider: 'local-pty' }, box: { provider: 'local-pty' } },
    });

    const spawned = await first.sendRequest('session.spawn', {
      cwd: '/tmp',
      target: 'box',
      resume: 'a-box',
    });

    const id = getRecord(spawned, 'session')['id'];

    await first.sendRequest('session.eject', { session: id, prompt: 'carry on' });

    await waitFor(async () => {
      const listed = await first.sendRequest('session.list');

      expect(listed).toMatchObject({ sessions: [{ id, state: 'done' }] });
    });

    const second = await daemon.openDaemon({
      targets: { local: { provider: 'local-pty' }, box: changed },
    });

    await second.sendRequest('fleet.restore', { cols: 80, rows: 24 });

    const input = second.sendRequest('session.input', { session: id, d: 'go\r' });
    const adopt = second.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

    const listed = await second.sendRequest('session.list');

    expect(input).rejects.toMatchObject({ code: 'target_changed', data: { target: 'box' } });
    expect(adopt).rejects.toMatchObject({ code: 'target_changed', data: { target: 'box' } });

    expect(listed).toMatchObject({
      sessions: [{ id, lastMsg: "target 'box' changed", alive: false }],
    });

    expect(daemon.runs).toHaveLength(1);
    expect(daemon.harnesses).toStrictEqual(['box']);
  },
);

test('it revives a session on its target after a restart with the config unchanged', async () => {
  await using daemon = await setupTest();

  const config = { targets: { local: { provider: 'local-pty' }, box: { provider: 'local-pty' } } };

  const first = await daemon.openDaemon(config);

  const spawned = await first.sendRequest('session.spawn', {
    cwd: '/tmp',
    target: 'box',
    resume: 'a-box',
  });

  const id = getRecord(spawned, 'session')['id'];

  await waitFor(async () => {
    const stored = await first.sendRequest('fleet.list');

    expect(stored).toMatchObject({ fleet: [{ sessionID: id, agentSessionID: 'a-box' }] });
  });

  const second = await daemon.openDaemon(config);

  await second.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const listed = await second.sendRequest('session.list');

  expect(listed).toMatchObject({ sessions: [{ id, alive: true, locator: { targetID: 'box' } }] });
  expect(daemon.harnesses).toStrictEqual(['box', 'box']);
});

test('it keeps existing sessions on their target and spawns new ones on a changed default', async () => {
  await using daemon = await setupTest();

  const targets = { local: { provider: 'local-pty' }, box: { provider: 'local-pty' } };

  const first = await daemon.openDaemon({ targets, defaultTarget: 'local' });
  const spawned = await first.sendRequest('session.spawn', { cwd: '/tmp', resume: 'a-old' });

  const oldID = getRecord(spawned, 'session')['id'];

  await waitFor(async () => {
    const stored = await first.sendRequest('fleet.list');

    expect(stored).toMatchObject({ fleet: [{ sessionID: oldID, agentSessionID: 'a-old' }] });
  });

  const second = await daemon.openDaemon({ targets, defaultTarget: 'box' });

  await second.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const fresh = await second.sendRequest('session.spawn', { cwd: '/tmp' });
  const old = await second.sendRequest('session.get', { session: oldID });

  expect(getRecord(fresh, 'session')['locator']).toMatchObject({ targetID: 'box' });
  expect(old).toMatchObject({ session: { alive: true, locator: { targetID: 'local' } } });
  expect(daemon.harnesses).toStrictEqual(['local', 'local', 'box']);
});

test('it revives a restored session without a stored target on the implicit local target', async () => {
  await using daemon = await setupTest([
    {
      sessionID: toSessionID('s-old'),
      name: 'old work',
      cwd: '/tmp',
      agentSessionID: toAgentSessionID('a-old'),
      agent: 'claude',
    },
  ]);

  const client = await daemon.openDaemon({});

  await client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const listed = await client.sendRequest('session.list');

  expect(listed).toMatchObject({
    sessions: [{ id: 's-old', alive: true, locator: { targetID: 'local' } }],
  });

  expect(daemon.harnesses).toStrictEqual(['local']);
});
