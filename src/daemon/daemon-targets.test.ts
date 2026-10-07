import { expect, test } from 'bun:test';
import { getRecord } from '../shared/get-record';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toSessionID } from '../shared/to-session-id';
import { StateStore } from '../store/state-store';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { buildMockFleetEntry } from '../test-utils/build-mock-fleet-entry';
import { buildStubExecutionProvider } from '../test-utils/build-stub-execution-provider';
import { buildTargetOptionsFromConfig } from '../test-utils/build-target-options-from-config';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { waitFor } from '../test-utils/wait-for';
import { buildTargetIdentity } from './build-target-identity';

/**
 * The daemon's stand-ins. `providers` builds, for a target id, the provider
 * of each kind a test's config may hold: a `local-pty` target runs harnesses
 * on a real pseudo-terminal, and a `no-headless` target's provider can
 * neither start a terminal nor run a headless turn. The target id of each
 * harness started lands in `harnesses`. The agent's headless runner records
 * each prompt in `runs` and finishes the turn on the next tick with a
 * message that holds the prompt.
 */
function setupTest() {
  const harnesses: string[] = [];
  const runs: string[] = [];

  const adapter = buildMockAgentAdapter({
    headlessRunner: (opts, hooks) => {
      runs.push(opts.prompt);

      setTimeout(() => {
        hooks.onDone(`finished: ${opts.prompt}`);
      }, 0);

      return { stop: () => {} };
    },
  });

  const providers = new Map([
    [
      'local-pty',
      (id: string) =>
        buildStubExecutionProvider({
          kind: 'local-pty',
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

  return { adapter, harnesses, runs, providers };
}

test('it spawns a session on the target the spawn names and records it in the fleet', async () => {
  const ctx = setupTest();

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-targets-',
    options: () => ({
      adapter: ctx.adapter,
      ejectSettleMs: 0,
      ...buildTargetOptionsFromConfig(
        {
          targets: { local: { provider: 'local-pty' }, box: { provider: 'local-pty', size: 2 } },
        },
        ctx.providers,
      ),
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'box',
  });

  const session = getRecord(spawned, 'session');

  const stored = await waitFor(async () => {
    const listed = await daemon.client.sendRequest('fleet.list');

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
  const ctx = setupTest();

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-targets-',
    options: () => ({
      adapter: ctx.adapter,
      ejectSettleMs: 0,
      ...buildTargetOptionsFromConfig({}, ctx.providers),
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', { cwd: daemon.dir });

  expect(getRecord(spawned, 'session')['locator']).toStrictEqual({
    daemonID: expect.toBeString(),
    targetID: 'local',
  });

  expect(ctx.harnesses).toStrictEqual(['local']);
});

test('it refuses a spawn to a target the config does not hold with unknown_target', async () => {
  const ctx = setupTest();

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-targets-',
    options: () => ({
      adapter: ctx.adapter,
      ejectSettleMs: 0,
      ...buildTargetOptionsFromConfig({}, ctx.providers),
    }),
  });

  const spawn = daemon.client.sendRequest('session.spawn', { cwd: daemon.dir, target: 'nope' });

  expect(spawn).rejects.toMatchObject({ code: 'unknown_target', data: { target: 'nope' } });
  expect(daemon.client.sendRequest('session.list')).resolves.toStrictEqual({ sessions: [] });
  expect(ctx.harnesses).toStrictEqual([]);
});

test('it refuses a spawn to a target this daemon has no provider for with target_unavailable', async () => {
  const ctx = setupTest();

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-targets-',
    options: () => ({
      adapter: ctx.adapter,
      ejectSettleMs: 0,
      ...buildTargetOptionsFromConfig(
        {
          targets: { local: { provider: 'local-pty' }, box: { provider: 'imp' } },
        },
        ctx.providers,
      ),
    }),
  });

  const spawn = daemon.client.sendRequest('session.spawn', { cwd: daemon.dir, target: 'box' });

  expect(spawn).rejects.toMatchObject({
    code: 'target_unavailable',
    data: { target: 'box', provider: 'imp' },
  });

  expect(daemon.client.sendRequest('session.list')).resolves.toStrictEqual({ sessions: [] });
  expect(ctx.harnesses).toStrictEqual([]);
});

test('it refuses a spawn to the local target when the targets map leaves it out', async () => {
  const ctx = setupTest();

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-targets-',
    options: () => ({
      adapter: ctx.adapter,
      ejectSettleMs: 0,
      ...buildTargetOptionsFromConfig(
        { targets: { box: { provider: 'local-pty' } } },
        ctx.providers,
      ),
    }),
  });

  const spawn = daemon.client.sendRequest('session.spawn', { cwd: daemon.dir, target: 'local' });

  expect(spawn).rejects.toMatchObject({ code: 'unknown_target' });
  expect(ctx.harnesses).toStrictEqual([]);
});

test('it refuses a spawn without a target, and starts no terminal, for a malformed targets map', async () => {
  const ctx = setupTest();

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-targets-',
    options: () => ({
      adapter: ctx.adapter,
      ejectSettleMs: 0,
      ...buildTargetOptionsFromConfig({ targets: ['local'] }, ctx.providers),
    }),
  });

  const spawn = daemon.client.sendRequest('session.spawn', { cwd: daemon.dir });

  expect(spawn).rejects.toMatchObject({
    code: 'target_config_invalid',
    data: { problem: 'targets must be a non-empty object of named targets' },
  });

  expect(daemon.client.sendRequest('session.list')).resolves.toStrictEqual({ sessions: [] });
  expect(ctx.harnesses).toStrictEqual([]);
});

test('it refuses a spawn to local, and starts no terminal, for a malformed targets map', async () => {
  const ctx = setupTest();

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-targets-',
    options: () => ({
      adapter: ctx.adapter,
      ejectSettleMs: 0,
      ...buildTargetOptionsFromConfig({ targets: 'local' }, ctx.providers),
    }),
  });

  const spawn = daemon.client.sendRequest('session.spawn', { cwd: daemon.dir, target: 'local' });

  expect(spawn).rejects.toMatchObject({ code: 'target_config_invalid', data: { target: 'local' } });
  expect(ctx.harnesses).toStrictEqual([]);
});

test('it refuses a spawn to a malformed target entry', async () => {
  const ctx = setupTest();

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-targets-',
    options: () => ({
      adapter: ctx.adapter,
      ejectSettleMs: 0,
      ...buildTargetOptionsFromConfig(
        {
          targets: { local: { provider: 'local-pty' }, box: { image: 'dev' } },
        },
        ctx.providers,
      ),
    }),
  });

  const spawn = daemon.client.sendRequest('session.spawn', { cwd: daemon.dir, target: 'box' });

  expect(spawn).rejects.toMatchObject({ code: 'target_config_invalid', data: { target: 'box' } });
  expect(ctx.harnesses).toStrictEqual([]);
});

test('it spawns on a well-formed target beside a malformed target entry', async () => {
  const ctx = setupTest();

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-targets-',
    options: () => ({
      adapter: ctx.adapter,
      ejectSettleMs: 0,
      ...buildTargetOptionsFromConfig(
        {
          targets: { local: { provider: 'local-pty' }, box: { image: 'dev' } },
        },
        ctx.providers,
      ),
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', { cwd: daemon.dir });

  expect(getRecord(spawned, 'session')['locator']).toStrictEqual({
    daemonID: expect.toBeString(),
    targetID: 'local',
  });

  expect(ctx.harnesses).toStrictEqual(['local']);
});

test('it refuses a spawn without a target, and starts no terminal, for an unknown defaultTarget', async () => {
  const ctx = setupTest();

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-targets-',
    options: () => ({
      adapter: ctx.adapter,
      ejectSettleMs: 0,
      ...buildTargetOptionsFromConfig(
        {
          targets: { local: { provider: 'local-pty' } },
          defaultTarget: 'gone',
        },
        ctx.providers,
      ),
    }),
  });

  const spawn = daemon.client.sendRequest('session.spawn', { cwd: daemon.dir });

  expect(spawn).rejects.toMatchObject({
    code: 'target_config_invalid',
    data: { problem: 'defaultTarget: matches no well-formed target in targets' },
  });

  expect(ctx.harnesses).toStrictEqual([]);
});

test('it lists each target and each config error', async () => {
  const ctx = setupTest();

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-targets-',
    options: () => ({
      adapter: ctx.adapter,
      ejectSettleMs: 0,
      ...buildTargetOptionsFromConfig(
        {
          targets: { local: { provider: 'local-pty' }, box: { provider: 'imp' }, bad: 3 },
          defaultTarget: 'box',
        },
        ctx.providers,
      ),
    }),
  });

  const listed = await daemon.client.sendRequest('agents.list');

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
    const ctx = setupTest();

    await using daemon = await startTestDaemon({
      prefix: 'atc-daemon-targets-',
      options: async (paths) => {
        const store = await StateStore.open(paths.dbPath);

        await store.writeFleet([
          buildMockFleetEntry({
            sessionID: toSessionID('s-box'),
            cwd: paths.dir,
            agentSessionID: toAgentSessionID('a-box'),
            target: 'box',
            targetIdentity: buildTargetIdentity(boundKind, {}),
          }),
        ]);

        await store.stop();

        return {
          adapter: ctx.adapter,
          ejectSettleMs: 0,
          ...buildTargetOptionsFromConfig({ targets }, ctx.providers),
        };
      },
    });

    await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

    const input = daemon.client.sendRequest('session.input', { session: 's-box', d: 'go\r' });

    expect(input).rejects.toMatchObject({ code, data: { target: 'box' } });
    expect(ctx.runs).toStrictEqual([]);
    expect(ctx.harnesses).toStrictEqual([]);
  },
);

test('it refuses input to a restored headless session on local once the targets map turns local off', async () => {
  const ctx = setupTest();

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-targets-',
    options: async (paths) => {
      const store = await StateStore.open(paths.dbPath);

      await store.writeFleet([
        buildMockFleetEntry({
          sessionID: toSessionID('s-old'),
          cwd: paths.dir,
          agentSessionID: toAgentSessionID('a-old'),
        }),
      ]);

      await store.stop();

      return {
        adapter: ctx.adapter,
        ejectSettleMs: 0,
        ...buildTargetOptionsFromConfig(
          { targets: { box: { provider: 'local-pty' } } },
          ctx.providers,
        ),
      };
    },
  });

  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const input = daemon.client.sendRequest('session.input', { session: 's-old', d: 'go\r' });

  expect(input).rejects.toMatchObject({ code: 'unknown_target', data: { target: 'local' } });
  expect(ctx.runs).toStrictEqual([]);
  expect(ctx.harnesses).toStrictEqual([]);
});

test('it refuses input to a restored headless session whose provider runs no headless turns, without running it', async () => {
  const ctx = setupTest();

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-targets-',
    options: async (paths) => {
      const store = await StateStore.open(paths.dbPath);

      await store.writeFleet([
        buildMockFleetEntry({
          sessionID: toSessionID('s-box'),
          cwd: paths.dir,
          agentSessionID: toAgentSessionID('a-box'),
          target: 'box',
          targetIdentity: buildTargetIdentity('no-headless', {}),
        }),
      ]);

      await store.stop();

      return {
        adapter: ctx.adapter,
        ejectSettleMs: 0,
        ...buildTargetOptionsFromConfig(
          {
            targets: { local: { provider: 'local-pty' }, box: { provider: 'no-headless' } },
          },
          ctx.providers,
        ),
      };
    },
  });

  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const input = daemon.client.sendRequest('session.input', { session: 's-box', d: 'go\r' });

  expect(input).rejects.toMatchObject({
    code: 'unsupported_operation',
    data: { provider: 'no-headless', capability: 'headless' },
  });

  expect(ctx.runs).toStrictEqual([]);
});

test('it refuses input to a killed headless session on a working target, without running it', async () => {
  const ctx = setupTest();

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-targets-',
    options: async (paths) => {
      const store = await StateStore.open(paths.dbPath);

      await store.writeFleet([
        buildMockFleetEntry({
          sessionID: toSessionID('s-old'),
          cwd: paths.dir,
          agentSessionID: toAgentSessionID('a-old'),
          exited: true,
        }),
      ]);

      await store.stop();

      return {
        adapter: ctx.adapter,
        ejectSettleMs: 0,
        ...buildTargetOptionsFromConfig({}, ctx.providers),
      };
    },
  });

  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const input = daemon.client.sendRequest('session.input', { session: 's-old', d: 'go\r' });

  expect(input).rejects.toMatchObject({ code: 'session_dead' });
  expect(ctx.runs).toStrictEqual([]);
});

test('it runs a local headless turn through the runner once per request', async () => {
  const ctx = setupTest();

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-targets-',
    options: () => ({
      adapter: ctx.adapter,
      ejectSettleMs: 0,
      ...buildTargetOptionsFromConfig({}, ctx.providers),
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    resume: 'a-1',
  });

  const id = getRecord(spawned, 'session')['id'];

  await daemon.client.sendRequest('session.eject', { session: id, prompt: 'carry on' });

  await waitFor(async () => {
    const listed = await daemon.client.sendRequest('session.list');

    expect(listed).toMatchObject({ sessions: [{ id, state: 'done' }] });
  });

  await daemon.client.sendRequest('session.input', { session: id, d: 'next step\n' });

  await waitFor(async () => {
    const listed = await daemon.client.sendRequest('session.list');

    expect(listed).toMatchObject({ sessions: [{ id, lastMsg: 'finished: next step' }] });
  });

  expect(ctx.runs).toStrictEqual(['carry on', 'next step']);
});

test.each([
  ['another provider', { provider: 'no-headless' }],
  ['other options', { provider: 'local-pty', image: 'ci' }],
])(
  'it refuses input to a session whose target name now holds %s, without running it',
  async (_label, changed) => {
    const ctx = setupTest();

    await using daemon = await startTestDaemon({
      prefix: 'atc-daemon-targets-',
      options: () => ({
        adapter: ctx.adapter,
        ejectSettleMs: 0,
        ...buildTargetOptionsFromConfig(
          {
            targets: { local: { provider: 'local-pty' }, box: { provider: 'local-pty' } },
          },
          ctx.providers,
        ),
      }),
    });

    const spawned = await daemon.client.sendRequest('session.spawn', {
      cwd: daemon.dir,
      target: 'box',
      resume: 'a-box',
    });

    const id = getRecord(spawned, 'session')['id'];

    await daemon.client.sendRequest('session.eject', { session: id, prompt: 'carry on' });

    await waitFor(async () => {
      const listed = await daemon.client.sendRequest('session.list');

      expect(listed).toMatchObject({ sessions: [{ id, state: 'done' }] });
    });

    await daemon.restart(() => ({
      adapter: ctx.adapter,
      ejectSettleMs: 0,
      ...buildTargetOptionsFromConfig(
        { targets: { local: { provider: 'local-pty' }, box: changed } },
        ctx.providers,
      ),
    }));

    await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

    const input = daemon.client.sendRequest('session.input', { session: id, d: 'go\r' });

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
    const ctx = setupTest();

    await using daemon = await startTestDaemon({
      prefix: 'atc-daemon-targets-',
      options: () => ({
        adapter: ctx.adapter,
        ejectSettleMs: 0,
        ...buildTargetOptionsFromConfig(
          {
            targets: { local: { provider: 'local-pty' }, box: { provider: 'local-pty' } },
          },
          ctx.providers,
        ),
      }),
    });

    const spawned = await daemon.client.sendRequest('session.spawn', {
      cwd: daemon.dir,
      target: 'box',
      resume: 'a-box',
    });

    const id = getRecord(spawned, 'session')['id'];

    await daemon.client.sendRequest('session.eject', { session: id, prompt: 'carry on' });

    await waitFor(async () => {
      const listed = await daemon.client.sendRequest('session.list');

      expect(listed).toMatchObject({ sessions: [{ id, state: 'done' }] });
    });

    await daemon.restart(() => ({
      adapter: ctx.adapter,
      ejectSettleMs: 0,
      ...buildTargetOptionsFromConfig(
        { targets: { local: { provider: 'local-pty' }, box: changed } },
        ctx.providers,
      ),
    }));

    await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

    const adopt = daemon.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

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
    const ctx = setupTest();

    await using daemon = await startTestDaemon({
      prefix: 'atc-daemon-targets-',
      options: () => ({
        adapter: ctx.adapter,
        ejectSettleMs: 0,
        ...buildTargetOptionsFromConfig(
          {
            targets: { local: { provider: 'local-pty' }, box: { provider: 'local-pty' } },
          },
          ctx.providers,
        ),
      }),
    });

    const spawned = await daemon.client.sendRequest('session.spawn', {
      cwd: daemon.dir,
      target: 'box',
      resume: 'a-box',
    });

    const id = getRecord(spawned, 'session')['id'];

    await daemon.client.sendRequest('session.eject', { session: id, prompt: 'carry on' });

    await waitFor(async () => {
      const listed = await daemon.client.sendRequest('session.list');

      expect(listed).toMatchObject({ sessions: [{ id, state: 'done' }] });
    });

    await daemon.restart(() => ({
      adapter: ctx.adapter,
      ejectSettleMs: 0,
      ...buildTargetOptionsFromConfig(
        { targets: { local: { provider: 'local-pty' }, box: changed } },
        ctx.providers,
      ),
    }));

    await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

    const listed = await daemon.client.sendRequest('session.list');

    expect(listed).toMatchObject({
      sessions: [{ id, lastMsg: "target 'box' changed", alive: false }],
    });

    expect(ctx.harnesses).toStrictEqual(['box']);
  },
);

test('it revives a session on its target after a restart with the config unchanged', async () => {
  const ctx = setupTest();

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-targets-',
    options: () => ({
      adapter: ctx.adapter,
      ejectSettleMs: 0,
      ...buildTargetOptionsFromConfig(
        {
          targets: { local: { provider: 'local-pty' }, box: { provider: 'local-pty' } },
        },
        ctx.providers,
      ),
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    target: 'box',
    resume: 'a-box',
  });

  const id = getRecord(spawned, 'session')['id'];

  await waitFor(async () => {
    const stored = await daemon.client.sendRequest('fleet.list');

    expect(stored).toMatchObject({ fleet: [{ sessionID: id, agentSessionID: 'a-box' }] });
  });

  await daemon.restart(() => ({
    adapter: ctx.adapter,
    ejectSettleMs: 0,
    ...buildTargetOptionsFromConfig(
      {
        targets: { local: { provider: 'local-pty' }, box: { provider: 'local-pty' } },
      },
      ctx.providers,
    ),
  }));

  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const listed = await daemon.client.sendRequest('session.list');

  expect(listed).toMatchObject({ sessions: [{ id, alive: true, locator: { targetID: 'box' } }] });
  expect(ctx.harnesses).toStrictEqual(['box', 'box']);
});

test('it spawns a new session on the default a restart changed', async () => {
  const ctx = setupTest();

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-targets-',
    options: () => ({
      adapter: ctx.adapter,
      ejectSettleMs: 0,
      ...buildTargetOptionsFromConfig(
        {
          targets: { local: { provider: 'local-pty' }, box: { provider: 'local-pty' } },
          defaultTarget: 'local',
        },
        ctx.providers,
      ),
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    resume: 'a-old',
  });

  const oldID = getRecord(spawned, 'session')['id'];

  await waitFor(async () => {
    const stored = await daemon.client.sendRequest('fleet.list');

    expect(stored).toMatchObject({ fleet: [{ sessionID: oldID, agentSessionID: 'a-old' }] });
  });

  await daemon.restart(() => ({
    adapter: ctx.adapter,
    ejectSettleMs: 0,
    ...buildTargetOptionsFromConfig(
      {
        targets: { local: { provider: 'local-pty' }, box: { provider: 'local-pty' } },
        defaultTarget: 'box',
      },
      ctx.providers,
    ),
  }));

  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const fresh = await daemon.client.sendRequest('session.spawn', { cwd: daemon.dir });

  expect(getRecord(fresh, 'session')['locator']).toStrictEqual({
    daemonID: expect.toBeString(),
    targetID: 'box',
  });

  expect(ctx.harnesses).toStrictEqual(['local', 'local', 'box']);
});

test('it keeps a restored session on its target after a restart changed the default', async () => {
  const ctx = setupTest();

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-targets-',
    options: () => ({
      adapter: ctx.adapter,
      ejectSettleMs: 0,
      ...buildTargetOptionsFromConfig(
        {
          targets: { local: { provider: 'local-pty' }, box: { provider: 'local-pty' } },
          defaultTarget: 'local',
        },
        ctx.providers,
      ),
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    resume: 'a-old',
  });

  const oldID = getRecord(spawned, 'session')['id'];

  await waitFor(async () => {
    const stored = await daemon.client.sendRequest('fleet.list');

    expect(stored).toMatchObject({ fleet: [{ sessionID: oldID, agentSessionID: 'a-old' }] });
  });

  await daemon.restart(() => ({
    adapter: ctx.adapter,
    ejectSettleMs: 0,
    ...buildTargetOptionsFromConfig(
      {
        targets: { local: { provider: 'local-pty' }, box: { provider: 'local-pty' } },
        defaultTarget: 'box',
      },
      ctx.providers,
    ),
  }));

  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const old = await daemon.client.sendRequest('session.get', { session: oldID });

  expect(old).toMatchObject({ session: { alive: true, locator: { targetID: 'local' } } });
  expect(ctx.harnesses).toStrictEqual(['local', 'local']);
});

test('it revives a restored session without a stored target on the implicit local target', async () => {
  const ctx = setupTest();

  await using daemon = await startTestDaemon({
    prefix: 'atc-daemon-targets-',
    options: async (paths) => {
      const store = await StateStore.open(paths.dbPath);

      await store.writeFleet([
        buildMockFleetEntry({
          sessionID: toSessionID('s-old'),
          cwd: paths.dir,
          agentSessionID: toAgentSessionID('a-old'),
        }),
      ]);

      await store.stop();

      return {
        adapter: ctx.adapter,
        ejectSettleMs: 0,
        ...buildTargetOptionsFromConfig({}, ctx.providers),
      };
    },
  });

  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const listed = await daemon.client.sendRequest('session.list');

  expect(listed).toMatchObject({
    sessions: [{ id: 's-old', alive: true, locator: { targetID: 'local' } }],
  });

  expect(ctx.harnesses).toStrictEqual(['local']);
});
