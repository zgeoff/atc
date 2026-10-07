import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildAgentAdapters } from '../agents/build-agent-adapters';
import { parseConfig } from '../shared/config';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toSessionID } from '../shared/to-session-id';
import type { FleetEntry } from '../store/fleet-entry';
import { StateStore } from '../store/state-store';
import { createStubBin } from '../test-utils/create-stub-bin';
import { FixtureImpPort } from '../test-utils/fixture-imp-port';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { waitFor } from '../test-utils/wait-for';
import { ImpProvider } from './imp-provider';
import { LocalPTYProvider } from './local-pty-provider';

interface SetupConfig {
  // The fleet the store holds when the daemon starts, given the daemon's
  // temp directory.
  readonly fleet?: (dir: string) => readonly FleetEntry[];
}

/**
 * A real daemon with a `local` target and an imp target `box` over a
 * fixture imp port, and two gateways whose binary is a fake Claude that
 * appends its arguments to `marker` on each start: `glm` takes its
 * credential through `auth`, and `zai` takes none. The store starts with
 * the fleet the config gives.
 */
async function setupTest(config: SetupConfig = {}) {
  const fleet = config.fleet ?? (() => []);

  await using stack = new AsyncDisposableStack();

  const port = stack.use(new FixtureImpPort());

  const daemon = await startTestDaemon({
    prefix: 'atc-auth-gateway-',
    options: async (paths) => {
      const fakeClaude = createStubBin(
        paths.dir,
        'fake-claude',
        `#!/bin/sh\necho "$@" >> "${join(paths.dir, 'started')}"\nexec sleep 30\n`,
      );

      const store = await StateStore.open(paths.dbPath);

      await store.writeFleet(fleet(paths.dir));
      await store.stop();

      // The gateways and their auth profile are what every test spawns or
      // lists.
      const parsed = parseConfig({
        authProfiles: {
          glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
        },
        agents: {
          claude: { bin: fakeClaude },
          glm: {
            kind: 'claude',
            bin: fakeClaude,
            baseURL: 'https://api.z.ai/api/anthropic',
            auth: {
              profiles: ['glm'],
              placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
            },
          },
          zai: { kind: 'claude', bin: fakeClaude, baseURL: 'https://api.z.ai/api/anthropic' },
        },
      });

      return {
        adapters: buildAgentAdapters(parsed),
        targets: [
          {
            id: 'local',
            kind: 'local-pty',
            options: {},
            identity: 'local-pty:test',
            provider: new LocalPTYProvider(),
          },
          {
            id: 'box',
            kind: 'imp',
            options: {},
            identity: 'imp:test',
            provider: new ImpProvider(
              port,
              { guestDir: join(paths.dir, 'g') },
              { atcBinary: null },
            ),
          },
        ],
        defaultTarget: 'local',
      };
    },
  });

  stack.use(daemon);

  const owned = stack.move();

  return Object.assign(daemon, {
    port,
    marker: join(daemon.dir, 'started'),
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  });
}

test('it refuses a local spawn of a gateway with auth and starts no harness', async () => {
  await using ctx = await setupTest();

  const spawn = ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'local',
  });

  expect(spawn).rejects.toMatchObject({ code: 'auth_target_unsupported' });

  await spawn.catch(() => null);

  const listed = await ctx.client.sendRequest('session.list');

  expect({ listed, started: existsSync(ctx.marker) }).toStrictEqual({
    listed: { sessions: [] },
    started: false,
  });
});

test('it refuses an imp spawn of a gateway with auth before touching impd', async () => {
  await using ctx = await setupTest();

  const spawn = ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
  });

  expect(spawn).rejects.toMatchObject({ code: 'auth_target_unsupported' });

  await spawn.catch(() => null);

  expect({
    calls: ctx.port.calls,
    sessions: ctx.port.sessionRequests,
    started: existsSync(ctx.marker),
  }).toStrictEqual({ calls: [], sessions: [], started: false });
});

test('it starts the harness of a gateway without auth on a local spawn', async () => {
  await using ctx = await setupTest();

  await ctx.client.sendRequest('session.spawn', { cwd: ctx.dir, agent: 'zai', target: 'local' });

  await waitFor(() => {
    expect(existsSync(ctx.marker)).toBeTrue();
  });
});

test('it lists a gateway with auth as able to spawn, since a target with a broker binding can start it', async () => {
  await using ctx = await setupTest();

  const answer = await ctx.client.sendRequest('agents.list');

  expect(answer).toMatchObject({
    agents: [
      { id: 'claude' },
      { id: 'glm', installed: true, capabilities: { spawn: true } },
      { id: 'zai', installed: true, capabilities: { spawn: true } },
    ],
  });
});

test('it refuses a local spawn that resumes a session of a gateway with auth and starts no harness', async () => {
  await using ctx = await setupTest();

  const spawn = ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'local',
    resume: 'a1',
  });

  expect(spawn).rejects.toMatchObject({ code: 'auth_target_unsupported' });

  await spawn.catch(() => null);

  const listed = await ctx.client.sendRequest('session.list');

  expect({ listed, started: existsSync(ctx.marker) }).toStrictEqual({
    listed: { sessions: [] },
    started: false,
  });
});

test('it refuses to adopt a restored local session of a gateway with auth and starts no harness', async () => {
  await using ctx = await setupTest({
    fleet: (dir) => [
      {
        sessionID: toSessionID('s1'),
        name: 'glm work',
        cwd: dir,
        agentSessionID: toAgentSessionID('a1'),
        agent: 'glm',
        exited: true,

        // Any file that exists, so the session counts as resumable.
        transcriptPath: import.meta.path,
        target: 'local',
        targetIdentity: 'local-pty:test',
      },
    ],
  });

  await ctx.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const adopt = ctx.client.sendRequest('session.adopt', { session: 's1' });

  expect(adopt).rejects.toMatchObject({ code: 'auth_target_unsupported' });

  await adopt.catch(() => null);

  expect(existsSync(ctx.marker)).toBeFalse();
});

test('it restores a local session of a gateway with auth without starting its harness', async () => {
  await using ctx = await setupTest({
    fleet: (dir) => [
      {
        sessionID: toSessionID('s1'),
        name: 'glm work',
        cwd: dir,
        agentSessionID: toAgentSessionID('a1'),
        agent: 'glm',
        target: 'local',
        targetIdentity: 'local-pty:test',

        // Any file that exists, so the session counts as resumable.
        transcriptPath: import.meta.path,
      },
    ],
  });

  await ctx.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  expect(existsSync(ctx.marker)).toBeFalse();
});
