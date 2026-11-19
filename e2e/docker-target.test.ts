import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getRecord } from '@atc/core/test-utils/get-record';
import { getString } from '@atc/core/test-utils/get-string';
import { resolveATCCommand } from '@atc/core/test-utils/resolve-atc-command';
import { setupTempDir } from '@atc/core/test-utils/setup-temp-dir';
import { waitFor } from '@atc/core/test-utils/wait-for';
import { createStandInImage } from '@atc/execution-docker/test-utils/create-stand-in-image';
import { readDockerLines } from '@atc/execution-docker/test-utils/read-docker-lines';
import { runDocker } from '@atc/execution-docker/test-utils/run-docker';
import { startDaemonProcess } from '@atc/lifecycle/test-utils/start-daemon-process';
import { waitForEvent } from '@atc/protocol/test-utils/wait-for-event';
import type { DaemonEvent } from '@atcx/contract';

// Runs the compiled daemon against the real Docker Engine of the machine, with a stand-in for
// the Claude CLI baked into an image. It needs the compiled binary (ATC_BIN) and a running Engine.
async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-e2e-docker-');
  const atc = resolveATCCommand();
  const prefix = `atce2e${Math.random().toString(36).slice(2, 8)}-`;
  const image = `${prefix}image`;
  const signIn = `${prefix}sign-in`;
  const configDir = join(temporaryDirectory.path, '.config', 'atc');

  // The daemon may still start a container while the test ends, so a pass that leaves volumes
  // behind runs again.
  onTestFinished(async () => {
    await waitFor(async () => {
      const containers = await readDockerLines('ps', '-aq', '--filter', `name=${prefix}`);

      if (containers.length > 0) {
        await runDocker('rm', '-f', ...containers);
      }

      const volumes = await readDockerLines('volume', 'ls', '-q', '--filter', `name=${prefix}`);

      if (volumes.length > 0) {
        await runDocker('volume', 'rm', '-f', ...volumes);
      }
    });

    await runDocker('rmi', '-f', image);
  });

  await createStandInImage(temporaryDirectory.path, image);
  await runDocker('volume', 'create', signIn);

  // the sign-in volume, as `claude setup-token` leaves it
  await runDocker(
    'run',
    '--rm',
    '--user',
    'root',
    '--entrypoint',
    'sh',
    '--volume',
    `${signIn}:/sign-in`,
    image,
    '-c',
    'printf %s not-a-real-token > /sign-in/claude-oauth-token && chmod 644 /sign-in/claude-oauth-token',
  );

  mkdirSync(configDir, { recursive: true });

  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({
      targets: { box: { provider: 'docker', image, namePrefix: prefix } },
      restoreFleetOnRestart: false,
    }),
  );

  const daemon = startDaemonProcess({ command: atc, home: temporaryDirectory.path });

  const client = await daemon.openClient();

  const events: DaemonEvent[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  return {
    client,
    events,
    signIn,
    runDocker,
    listHarnesses: async () => {
      const names = await readDockerLines(
        'ps',
        '-a',
        '--format',
        '{{.Names}}',
        '--filter',
        `name=${prefix}`,
      );

      return names.filter((name) => !name.endsWith('-relay')).toSorted();
    },
    listContainers: async () => {
      const names = await readDockerLines(
        'ps',
        '-a',
        '--format',
        '{{.Names}}',
        '--filter',
        `name=${prefix}`,
      );

      return names.toSorted();
    },
    listVolumes: async () => {
      const names = await readDockerLines('volume', 'ls', '-q', '--filter', `name=${prefix}`);

      return names.toSorted();
    },
    readHomeFile: (container: string, file: string) =>
      runDocker('exec', container, 'cat', `/home/agent/${file}`),
  };
}

test('it runs a session in containers, wakes it after a kill, and forgets it with the sign-in volume kept', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: '/home/agent',
    target: 'box',
    cols: 80,
    rows: 24,
  });

  const sessionID = getString(getRecord(spawned, 'session'), 'id');

  // the stand-in's hooks cross the relay and the real reporter to reach the daemon
  await waitForEvent(ctx.events, { ev: 'SessionState', session: { state: 'needs_you' } });

  const [harness = ''] = await ctx.listHarnesses();
  const running = await ctx.listContainers();
  const env = await ctx.runDocker('inspect', '--format', '{{json .Config.Env}}', harness);
  const seen = await ctx.readHomeFile(harness, 'token-seen');
  const configDirSeen = await ctx.readHomeFile(harness, 'config-dir-seen');

  expect(running).toHaveLength(2);
  expect(env).not.toInclude('not-a-real-token');
  expect(env).not.toInclude('CLAUDE_CODE_OAUTH_TOKEN');
  expect(seen).toBe('token-matches');
  expect(configDirSeen).toBe('1');

  await ctx.client.sendRequest('session.kill', { session: sessionID });

  await waitFor(async () => {
    const listed = await ctx.client.sendRequest('session.list');

    expect(listed).toMatchObject({ sessions: [{ alive: false }] });
  });

  await ctx.client.sendRequest('session.adopt', { session: sessionID, cols: 80, rows: 24 });

  await waitFor(async () => {
    const listed = await ctx.client.sendRequest('session.list');

    expect(listed).toMatchObject({ sessions: [{ alive: true }] });
  });

  const starts = await ctx.readHomeFile(harness, 'starts.log');

  expect(starts.split('\n')).toHaveLength(1);

  await ctx.client.sendRequest('session.kill', { session: sessionID });

  const offered = await ctx.client.sendRequest('session.forget', { session: sessionID });

  await ctx.client.sendRequest('session.forget', {
    session: sessionID,
    confirmToken: offered['confirmToken'],
  });

  await waitFor(async () => {
    const left = await ctx.listContainers();

    expect(left).toStrictEqual([]);
  });

  const volumes = await ctx.listVolumes();

  expect(volumes).toStrictEqual([ctx.signIn]);
});

test('it starts the resume command in a new container when the harness container died', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: '/home/agent',
    target: 'box',
    cols: 80,
    rows: 24,
  });

  const sessionID = getString(getRecord(spawned, 'session'), 'id');

  await waitForEvent(ctx.events, { ev: 'SessionState', session: { state: 'needs_you' } });

  const [harness = ''] = await ctx.listHarnesses();

  await ctx.runDocker('kill', harness);

  await waitFor(async () => {
    const listed = await ctx.client.sendRequest('session.list');

    expect(listed).toMatchObject({ sessions: [{ alive: false }] });
  });

  await ctx.client.sendRequest('session.adopt', { session: sessionID, cols: 80, rows: 24 });

  await waitFor(async () => {
    const listed = await ctx.client.sendRequest('session.list');

    expect(listed).toMatchObject({ sessions: [{ alive: true }] });
  });

  const [revived = ''] = await ctx.listHarnesses();

  await waitFor(async () => {
    const starts = await ctx.readHomeFile(revived, 'starts.log');

    expect(starts.split('\n')).toHaveLength(2);
  });

  const starts = await ctx.readHomeFile(revived, 'starts.log');

  expect(starts.split('\n')[1]).toInclude('--resume stand-in-1');
});
