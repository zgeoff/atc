import { expect, test } from 'bun:test';
import { collectTargets } from '../shared/collect-targets';
import { getRecord } from '../shared/get-record';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toSessionID } from '../shared/to-session-id';
import type { FleetEntry } from '../store/fleet-entry';
import { StateStore } from '../store/state-store';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { buildMockFleetEntry } from '../test-utils/build-mock-fleet-entry';
import { buildStubExecutionProvider } from '../test-utils/build-stub-execution-provider';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { waitFor } from '../test-utils/wait-for';
import { buildTargetIdentity } from './build-target-identity';

/**
 * A real daemon on a state directory that outlives restarts. `boot`
 * restarts it on the raw `targets` and `defaultTarget` keys of a config,
 * which the real parse turns into targets. A `local-pty` target runs
 * harnesses on a real pseudo-terminal, a `no-headless` target's provider
 * can neither start a terminal nor run a headless turn, and any other kind
 * has no provider; the target id of each harness started lands in
 * `harnesses`. `writeFleet` stops the daemon and stores the fleet rows
 * given, for the next boot to restore. The agent's headless runner records
 * each prompt in `runs` and finishes the turn on the next tick.
 */
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const harnesses: string[] = [];
  const runs: string[] = [];

  const adapter = buildMockAgentAdapter({
    headlessRunner: (opts, hooks) => {
      runs.push(opts.prompt);

      setTimeout(() => {
        hooks.onDone('turn finished');
      }, 0);

      return { stop: () => {} };
    },
  });

  const harness = await startTestDaemon({
    prefix: 'atc-daemon-targets-',
    options: () => ({ adapter }),
  });

  stack.use(harness);

  const owned = stack.move();

  return {
    dir: harness.dir,
    harnesses,
    runs,
    get client() {
      return harness.client;
    },
    async boot(raw: Partial<Readonly<Record<'targets' | 'defaultTarget', unknown>>>) {
      const parsed = collectTargets(raw.targets, raw.defaultTarget);

      const providers = new Map([
        [
          'local-pty',
          (id: string) =>
            buildStubExecutionProvider({
              kind: 'local-pty',
              capabilities: {},
              onSpawn: () => {
                harnesses.push(id);
              },
            }),
        ],
        [
          'no-headless',
          (id: string) =>
            buildStubExecutionProvider({
              kind: 'no-headless',
              capabilities: { spawn: false, headless: false },
              onSpawn: () => {
                harnesses.push(id);
              },
            }),
        ],
      ]);

      await harness.restart(() => ({
        adapter,
        ejectSettleMs: 0,
        targets: parsed.targets.map((target) => ({
          id: target.id,
          kind: target.provider,
          options: target.options,
          identity: buildTargetIdentity(target.provider, target.options),
          provider: providers.get(target.provider)?.(target.id) ?? null,
        })),
        defaultTarget: parsed.defaultTarget,
        targetErrors: parsed.errors,
      }));
    },
    async writeFleet(fleet: readonly FleetEntry[]) {
      await harness.stop();

      const store = await StateStore.open(harness.dbPath);

      await store.writeFleet(fleet);
      await store.stop();
    },
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it spawns a session on the target the spawn names and records it in the fleet', async () => {
  await using ctx = await setupTest();

  await ctx.boot({
    targets: { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
  });

  const spawned = await ctx.client.sendRequest('session.spawn', { cwd: ctx.dir, target: 'box' });

  const session = getRecord(spawned, 'session');

  const stored = await waitFor(async () => {
    const listed = await ctx.client.sendRequest('fleet.list');

    expect(listed['fleet']).toBeArrayOfSize(1);

    return listed;
  });

  expect(session['locator']).toStrictEqual({ daemonID: expect.toBeString(), targetID: 'box' });
  expect(ctx.harnesses).toStrictEqual(['box']);

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

test('it spawns a session without a target on the local target when the config sets no targets', async () => {
  await using ctx = await setupTest();

  await ctx.boot({});

  const spawned = await ctx.client.sendRequest('session.spawn', { cwd: ctx.dir });

  expect(getRecord(spawned, 'session')['locator']).toStrictEqual({
    daemonID: expect.toBeString(),
    targetID: 'local',
  });

  expect(ctx.harnesses).toStrictEqual(['local']);
});

test('it refuses a spawn to a target the config does not hold with unknown_target', async () => {
  await using ctx = await setupTest();

  await ctx.boot({});

  const spawn = ctx.client.sendRequest('session.spawn', { cwd: ctx.dir, target: 'nope' });

  expect(spawn).rejects.toMatchObject({ code: 'unknown_target', data: { target: 'nope' } });
  expect(ctx.client.sendRequest('session.list')).resolves.toStrictEqual({ sessions: [] });
  expect(ctx.harnesses).toStrictEqual([]);
});

test('it refuses a spawn to a target this daemon has no provider for with target_unavailable', async () => {
  await using ctx = await setupTest();

  await ctx.boot({ targets: { local: { provider: 'local-pty' }, box: { provider: 'imp' } } });

  const spawn = ctx.client.sendRequest('session.spawn', { cwd: ctx.dir, target: 'box' });

  expect(spawn).rejects.toMatchObject({
    code: 'target_unavailable',
    data: { target: 'box', provider: 'imp' },
  });

  expect(ctx.client.sendRequest('session.list')).resolves.toStrictEqual({ sessions: [] });
  expect(ctx.harnesses).toStrictEqual([]);
});

test('it refuses a spawn to the local target when the targets map leaves it out', async () => {
  await using ctx = await setupTest();

  await ctx.boot({ targets: { box: { provider: 'local-pty' } } });

  const spawn = ctx.client.sendRequest('session.spawn', { cwd: ctx.dir, target: 'local' });

  expect(spawn).rejects.toMatchObject({ code: 'unknown_target' });
  expect(ctx.harnesses).toStrictEqual([]);
});

test('it refuses a spawn without a target, and starts no terminal, for a malformed targets map', async () => {
  await using ctx = await setupTest();

  await ctx.boot({ targets: ['local'] });

  const spawn = ctx.client.sendRequest('session.spawn', { cwd: ctx.dir });

  expect(spawn).rejects.toMatchObject({
    code: 'target_config_invalid',
    data: { problem: 'targets must be a non-empty object of named targets' },
  });

  expect(ctx.client.sendRequest('session.list')).resolves.toStrictEqual({ sessions: [] });
  expect(ctx.harnesses).toStrictEqual([]);
});

test('it refuses a spawn to local, and starts no terminal, for a malformed targets map', async () => {
  await using ctx = await setupTest();

  await ctx.boot({ targets: 'local' });

  const spawn = ctx.client.sendRequest('session.spawn', { cwd: ctx.dir, target: 'local' });

  expect(spawn).rejects.toMatchObject({ code: 'target_config_invalid', data: { target: 'local' } });
  expect(ctx.harnesses).toStrictEqual([]);
});

test('it refuses a spawn to a malformed target entry', async () => {
  await using ctx = await setupTest();

  await ctx.boot({ targets: { local: { provider: 'local-pty' }, box: { image: 'dev' } } });

  const spawn = ctx.client.sendRequest('session.spawn', { cwd: ctx.dir, target: 'box' });

  expect(spawn).rejects.toMatchObject({ code: 'target_config_invalid', data: { target: 'box' } });
  expect(ctx.harnesses).toStrictEqual([]);
});

test('it spawns on a well-formed target beside a malformed target entry', async () => {
  await using ctx = await setupTest();

  await ctx.boot({ targets: { local: { provider: 'local-pty' }, box: { image: 'dev' } } });

  const spawned = await ctx.client.sendRequest('session.spawn', { cwd: ctx.dir });

  expect(getRecord(spawned, 'session')['locator']).toStrictEqual({
    daemonID: expect.toBeString(),
    targetID: 'local',
  });

  expect(ctx.harnesses).toStrictEqual(['local']);
});

test('it refuses a spawn without a target, and starts no terminal, for an unknown defaultTarget', async () => {
  await using ctx = await setupTest();

  await ctx.boot({ targets: { local: { provider: 'local-pty' } }, defaultTarget: 'gone' });

  const spawn = ctx.client.sendRequest('session.spawn', { cwd: ctx.dir });

  expect(spawn).rejects.toMatchObject({
    code: 'target_config_invalid',
    data: { problem: 'defaultTarget: matches no well-formed target in targets' },
  });

  expect(ctx.harnesses).toStrictEqual([]);
});

test('it lists each target and each config error', async () => {
  await using ctx = await setupTest();

  await ctx.boot({
    targets: { local: { provider: 'local-pty' }, box: { provider: 'imp' }, bad: 3 },
    defaultTarget: 'box',
  });

  const listed = await ctx.client.sendRequest('agents.list');

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
    await using ctx = await setupTest();

    await ctx.writeFleet([
      buildMockFleetEntry({
        sessionID: toSessionID('s-box'),
        cwd: ctx.dir,
        agentSessionID: toAgentSessionID('a-box'),
        target: 'box',
        targetIdentity: buildTargetIdentity(boundKind, {}),
      }),
    ]);

    await ctx.boot({ targets });
    await ctx.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

    const input = ctx.client.sendRequest('session.input', { session: 's-box', d: 'go\r' });

    expect(input).rejects.toMatchObject({ code, data: { target: 'box' } });
    expect(ctx.runs).toStrictEqual([]);
    expect(ctx.harnesses).toStrictEqual([]);
  },
);

test('it refuses input to a restored headless session on local once the targets map turns local off', async () => {
  await using ctx = await setupTest();

  await ctx.writeFleet([
    buildMockFleetEntry({
      sessionID: toSessionID('s-old'),
      cwd: ctx.dir,
      agentSessionID: toAgentSessionID('a-old'),
    }),
  ]);

  await ctx.boot({ targets: { box: { provider: 'local-pty' } } });
  await ctx.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const input = ctx.client.sendRequest('session.input', { session: 's-old', d: 'go\r' });

  expect(input).rejects.toMatchObject({ code: 'unknown_target', data: { target: 'local' } });
  expect(ctx.runs).toStrictEqual([]);
  expect(ctx.harnesses).toStrictEqual([]);
});

test('it refuses input to a restored headless session whose provider runs no headless turns, without running it', async () => {
  await using ctx = await setupTest();

  await ctx.writeFleet([
    buildMockFleetEntry({
      sessionID: toSessionID('s-box'),
      cwd: ctx.dir,
      agentSessionID: toAgentSessionID('a-box'),
      target: 'box',
      targetIdentity: buildTargetIdentity('no-headless', {}),
    }),
  ]);

  await ctx.boot({
    targets: { local: { provider: 'local-pty' }, box: { provider: 'no-headless' } },
  });

  await ctx.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const input = ctx.client.sendRequest('session.input', { session: 's-box', d: 'go\r' });

  expect(input).rejects.toMatchObject({
    code: 'unsupported_operation',
    data: { provider: 'no-headless', capability: 'headless' },
  });

  expect(ctx.runs).toStrictEqual([]);
});

test('it refuses input to a killed headless session on a working target, without running it', async () => {
  await using ctx = await setupTest();

  await ctx.writeFleet([
    buildMockFleetEntry({
      sessionID: toSessionID('s-old'),
      cwd: ctx.dir,
      agentSessionID: toAgentSessionID('a-old'),
      exited: true,
    }),
  ]);

  await ctx.boot({});
  await ctx.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const input = ctx.client.sendRequest('session.input', { session: 's-old', d: 'go\r' });

  expect(input).rejects.toMatchObject({ code: 'session_dead' });
  expect(ctx.runs).toStrictEqual([]);
});

test('it runs a local headless turn through the runner once per request', async () => {
  await using ctx = await setupTest();

  await ctx.boot({});

  const spawned = await ctx.client.sendRequest('session.spawn', { cwd: ctx.dir, resume: 'a-1' });

  const id = getRecord(spawned, 'session')['id'];

  await ctx.client.sendRequest('session.eject', { session: id, prompt: 'carry on' });

  await waitFor(async () => {
    const listed = await ctx.client.sendRequest('session.list');

    expect(listed).toMatchObject({ sessions: [{ id, state: 'done' }] });
  });

  await ctx.client.sendRequest('session.input', { session: id, d: 'next step\n' });

  await waitFor(async () => {
    const listed = await ctx.client.sendRequest('session.list');

    expect(listed).toMatchObject({ sessions: [{ id, lastMsg: 'turn finished' }] });
  });

  expect(ctx.runs).toStrictEqual(['carry on', 'next step']);
});

test.each([
  ['another provider', { provider: 'no-headless' }],
  ['other options', { provider: 'local-pty', image: 'ci' }],
])(
  'it refuses input to a session whose target name now holds %s, without running it',
  async (_label, changed) => {
    await using ctx = await setupTest();

    await ctx.boot({
      targets: { local: { provider: 'local-pty' }, box: { provider: 'local-pty' } },
    });

    const spawned = await ctx.client.sendRequest('session.spawn', {
      cwd: ctx.dir,
      target: 'box',
      resume: 'a-box',
    });

    const id = getRecord(spawned, 'session')['id'];

    await ctx.client.sendRequest('session.eject', { session: id, prompt: 'carry on' });

    await waitFor(async () => {
      const listed = await ctx.client.sendRequest('session.list');

      expect(listed).toMatchObject({ sessions: [{ id, state: 'done' }] });
    });

    await ctx.boot({ targets: { local: { provider: 'local-pty' }, box: changed } });
    await ctx.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

    const input = ctx.client.sendRequest('session.input', { session: id, d: 'go\r' });

    expect(input).rejects.toMatchObject({ code: 'target_changed', data: { target: 'box' } });
    expect(ctx.runs).toStrictEqual(['carry on']);
    expect(ctx.harnesses).toStrictEqual(['box']);
  },
);

test.each([
  ['another provider', { provider: 'no-headless' }],
  ['other options', { provider: 'local-pty', image: 'ci' }],
])(
  'it refuses to resume a session whose target name now holds %s, starting no terminal',
  async (_label, changed) => {
    await using ctx = await setupTest();

    await ctx.boot({
      targets: { local: { provider: 'local-pty' }, box: { provider: 'local-pty' } },
    });

    const spawned = await ctx.client.sendRequest('session.spawn', {
      cwd: ctx.dir,
      target: 'box',
      resume: 'a-box',
    });

    const id = getRecord(spawned, 'session')['id'];

    await ctx.client.sendRequest('session.eject', { session: id, prompt: 'carry on' });

    await waitFor(async () => {
      const listed = await ctx.client.sendRequest('session.list');

      expect(listed).toMatchObject({ sessions: [{ id, state: 'done' }] });
    });

    await ctx.boot({ targets: { local: { provider: 'local-pty' }, box: changed } });
    await ctx.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

    const adopt = ctx.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

    expect(adopt).rejects.toMatchObject({ code: 'target_changed', data: { target: 'box' } });
    expect(ctx.harnesses).toStrictEqual(['box']);
  },
);

test.each([
  ['another provider', { provider: 'no-headless' }],
  ['other options', { provider: 'local-pty', image: 'ci' }],
])(
  'it leaves a session whose target name now holds %s dead on a restore',
  async (_label, changed) => {
    await using ctx = await setupTest();

    await ctx.boot({
      targets: { local: { provider: 'local-pty' }, box: { provider: 'local-pty' } },
    });

    const spawned = await ctx.client.sendRequest('session.spawn', {
      cwd: ctx.dir,
      target: 'box',
      resume: 'a-box',
    });

    const id = getRecord(spawned, 'session')['id'];

    await ctx.client.sendRequest('session.eject', { session: id, prompt: 'carry on' });

    await waitFor(async () => {
      const listed = await ctx.client.sendRequest('session.list');

      expect(listed).toMatchObject({ sessions: [{ id, state: 'done' }] });
    });

    await ctx.boot({ targets: { local: { provider: 'local-pty' }, box: changed } });
    await ctx.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

    const listed = await ctx.client.sendRequest('session.list');

    expect(listed).toMatchObject({
      sessions: [{ id, lastMsg: "target 'box' changed", alive: false }],
    });

    expect(ctx.harnesses).toStrictEqual(['box']);
  },
);

test('it revives a session on its target after a restart with the config unchanged', async () => {
  await using ctx = await setupTest();

  await ctx.boot({ targets: { local: { provider: 'local-pty' }, box: { provider: 'local-pty' } } });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    target: 'box',
    resume: 'a-box',
  });

  const id = getRecord(spawned, 'session')['id'];

  await waitFor(async () => {
    const stored = await ctx.client.sendRequest('fleet.list');

    expect(stored).toMatchObject({ fleet: [{ sessionID: id, agentSessionID: 'a-box' }] });
  });

  await ctx.boot({ targets: { local: { provider: 'local-pty' }, box: { provider: 'local-pty' } } });
  await ctx.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const listed = await ctx.client.sendRequest('session.list');

  expect(listed).toMatchObject({ sessions: [{ id, alive: true, locator: { targetID: 'box' } }] });
  expect(ctx.harnesses).toStrictEqual(['box', 'box']);
});

test('it spawns a new session on the default a restart changed', async () => {
  await using ctx = await setupTest();

  await ctx.boot({
    targets: { local: { provider: 'local-pty' }, box: { provider: 'local-pty' } },
    defaultTarget: 'local',
  });

  const spawned = await ctx.client.sendRequest('session.spawn', { cwd: ctx.dir, resume: 'a-old' });

  const oldID = getRecord(spawned, 'session')['id'];

  await waitFor(async () => {
    const stored = await ctx.client.sendRequest('fleet.list');

    expect(stored).toMatchObject({ fleet: [{ sessionID: oldID, agentSessionID: 'a-old' }] });
  });

  await ctx.boot({
    targets: { local: { provider: 'local-pty' }, box: { provider: 'local-pty' } },
    defaultTarget: 'box',
  });

  await ctx.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const fresh = await ctx.client.sendRequest('session.spawn', { cwd: ctx.dir });

  expect(getRecord(fresh, 'session')['locator']).toStrictEqual({
    daemonID: expect.toBeString(),
    targetID: 'box',
  });

  expect(ctx.harnesses).toStrictEqual(['local', 'local', 'box']);
});

test('it keeps a restored session on its target after a restart changed the default', async () => {
  await using ctx = await setupTest();

  await ctx.boot({
    targets: { local: { provider: 'local-pty' }, box: { provider: 'local-pty' } },
    defaultTarget: 'local',
  });

  const spawned = await ctx.client.sendRequest('session.spawn', { cwd: ctx.dir, resume: 'a-old' });

  const oldID = getRecord(spawned, 'session')['id'];

  await waitFor(async () => {
    const stored = await ctx.client.sendRequest('fleet.list');

    expect(stored).toMatchObject({ fleet: [{ sessionID: oldID, agentSessionID: 'a-old' }] });
  });

  await ctx.boot({
    targets: { local: { provider: 'local-pty' }, box: { provider: 'local-pty' } },
    defaultTarget: 'box',
  });

  await ctx.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const old = await ctx.client.sendRequest('session.get', { session: oldID });

  expect(old).toMatchObject({ session: { alive: true, locator: { targetID: 'local' } } });
  expect(ctx.harnesses).toStrictEqual(['local', 'local']);
});

test('it revives a restored session without a stored target on the implicit local target', async () => {
  await using ctx = await setupTest();

  await ctx.writeFleet([
    buildMockFleetEntry({
      sessionID: toSessionID('s-old'),
      cwd: ctx.dir,
      agentSessionID: toAgentSessionID('a-old'),
    }),
  ]);

  await ctx.boot({});
  await ctx.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const listed = await ctx.client.sendRequest('session.list');

  expect(listed).toMatchObject({
    sessions: [{ id: 's-old', alive: true, locator: { targetID: 'local' } }],
  });

  expect(ctx.harnesses).toStrictEqual(['local']);
});
