import { expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FixtureImpPort } from '../../test/fixture-imp-port';
import { setupTempDir } from '../../test/setup-temp-dir';
import { waitFor } from '../../test/wait-for';
import { ClaudeAdapter } from '../agents/claude-adapter';
import { GatewayAdapter } from '../agents/gateway-adapter';
import { DaemonClient } from '../client/daemon-client';
import { parseConfig } from '../shared/config';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toSessionID } from '../shared/to-session-id';
import type { FleetEntry } from '../store/fleet-entry';
import { StateStore } from '../store/state-store';
import { startDaemon } from './daemon';
import { ImpProvider } from './imp-provider';
import { LocalPTYProvider } from './local-pty-provider';

// A real daemon with a `local` target and an imp target `box` over a
// fixture imp port, and two gateways whose binary is a fake claude that
// records each start in a marker file: `glm` takes its credential through
// `auth`, and `zai` takes none. The store starts with the fleet a test
// gives.
async function setupTest(fleet: readonly FleetEntry[] = []) {
  const tmp = setupTempDir('atc-auth-gateway-');
  const sockPath = join(tmp.dir, 'daemon.sock');
  const fakeClaude = join(tmp.dir, 'fake-claude');
  const marker = join(tmp.dir, 'started');

  writeFileSync(fakeClaude, `#!/bin/sh\necho "$@" >> "${marker}"\nexec sleep 30\n`, {
    mode: 0o755,
  });

  const config = parseConfig({
    claudeBin: fakeClaude,
    authProfiles: {
      glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
    },
    gateways: {
      glm: {
        baseURL: 'https://api.z.ai/api/anthropic',
        auth: {
          profiles: ['glm'],
          placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
        },
      },
      zai: { baseURL: 'https://api.z.ai/api/anthropic' },
    },
  });

  const dbPath = join(tmp.dir, 'state.db');

  if (fleet.length > 0) {
    const store = await StateStore.open(dbPath);

    await store.writeFleet(fleet);
    await store.stop();
  }

  const port = new FixtureImpPort();
  const claude = new ClaudeAdapter(config);

  const daemon = await startDaemon({
    socketPath: sockPath,
    reporterSocketPath: join(tmp.dir, 'reporter.sock'),
    build: 'atc/test-build',
    adapter: claude,
    adapters: [claude, ...config.gateways.map((gateway) => new GatewayAdapter(gateway, config))],
    dbPath,
    statusPath: join(tmp.dir, 'status.json'),
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
        provider: new ImpProvider(port, { guestDir: join(tmp.dir, 'g') }, { atcBinary: null }),
      },
    ],
    defaultTarget: 'local',
  });

  const client = await DaemonClient.open(sockPath);

  await client.sendHello('atc/test-build');

  return {
    client,
    port,
    marker,
    async [Symbol.asyncDispose]() {
      client.stop();

      await daemon.stop();

      port[Symbol.dispose]();
      tmp[Symbol.dispose]();
    },
  };
}

test('it refuses a local spawn of a gateway with auth and starts no harness', async () => {
  await using daemon = await setupTest();

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'glm',
    target: 'local',
  });

  expect(spawn).rejects.toMatchObject({ code: 'auth_target_unsupported' });

  await spawn.catch(() => null);

  const listed = await daemon.client.sendRequest('session.list');

  expect({ listed, started: existsSync(daemon.marker) }).toStrictEqual({
    listed: { sessions: [] },
    started: false,
  });
});

test('it refuses an imp spawn of a gateway with auth before touching impd', async () => {
  await using daemon = await setupTest();

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'glm',
    target: 'box',
  });

  expect(spawn).rejects.toMatchObject({ code: 'auth_target_unsupported' });

  await spawn.catch(() => null);

  expect({
    calls: daemon.port.calls,
    sessions: daemon.port.sessionRequests,
    started: existsSync(daemon.marker),
  }).toStrictEqual({ calls: [], sessions: [], started: false });
});

test('it spawns a gateway without auth as before', async () => {
  await using daemon = await setupTest();

  await daemon.client.sendRequest('session.spawn', { cwd: '/tmp', agent: 'zai', target: 'local' });

  const started = await waitFor(() => {
    expect(existsSync(daemon.marker)).toBeTrue();

    return true;
  });

  expect(started).toBeTrue();
});

test('it lists a gateway with auth as able to spawn, since a target with a broker binding can start it', async () => {
  await using daemon = await setupTest();

  const answer = await daemon.client.sendRequest('agents.list');

  expect(answer).toMatchObject({
    agents: [
      { id: 'claude' },
      { id: 'glm', installed: true, capabilities: { spawn: true } },
      { id: 'zai', installed: true, capabilities: { spawn: true } },
    ],
  });
});

test('it refuses a local spawn that resumes a session of a gateway with auth and starts no harness', async () => {
  await using daemon = await setupTest();

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'glm',
    target: 'local',
    resume: 'a1',
  });

  expect(spawn).rejects.toMatchObject({ code: 'auth_target_unsupported' });

  await spawn.catch(() => null);

  const listed = await daemon.client.sendRequest('session.list');

  expect({ listed, started: existsSync(daemon.marker) }).toStrictEqual({
    listed: { sessions: [] },
    started: false,
  });
});

test('it refuses to adopt a restored local session of a gateway with auth and starts no harness', async () => {
  await using daemon = await setupTest([
    {
      sessionID: toSessionID('s1'),
      name: 'glm work',
      cwd: '/tmp',
      agentSessionID: toAgentSessionID('a1'),
      agent: 'glm',
      exited: true,

      // Any file that exists, so the session counts as resumable.
      transcriptPath: import.meta.path,
      target: 'local',
      targetIdentity: 'local-pty:test',
    },
  ]);

  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const adopt = daemon.client.sendRequest('session.adopt', { session: 's1' });

  expect(adopt).rejects.toMatchObject({ code: 'auth_target_unsupported' });

  await adopt.catch(() => null);

  expect(existsSync(daemon.marker)).toBeFalse();
});

test('it restores a local session of a gateway with auth without starting its harness', async () => {
  await using daemon = await setupTest([
    {
      sessionID: toSessionID('s1'),
      name: 'glm work',
      cwd: '/tmp',
      agentSessionID: toAgentSessionID('a1'),
      agent: 'glm',
      target: 'local',
      targetIdentity: 'local-pty:test',

      // Any file that exists, so the session counts as resumable.
      transcriptPath: import.meta.path,
    },
  ]);

  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  expect(existsSync(daemon.marker)).toBeFalse();
});
