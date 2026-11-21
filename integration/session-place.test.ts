import { expect, test } from 'bun:test';
import { startTestDaemon } from '@atc/app/test-utils/start-test-daemon';
import type { TargetIdentityRule } from '@atc/core';
import { getRecord } from '@atc/core/test-utils/get-record';
import { buildStubMemoryProvider } from '@atc/daemon/test-utils/build-stub-memory-provider';
import { createStubEchoClaude } from '@atc/harness-claude/test-utils/create-stub-echo-claude';
import { buildMockAgentAdapter } from '@atc/plugin-api/test-utils/build-mock-agent-adapter';
import { waitForEvent } from '@atc/protocol/test-utils/wait-for-event';

interface BoxIdentity {
  readonly identity: string;
  readonly identityRule?: TargetIdentityRule;
}

interface DaemonPaths {
  readonly directory: string;
}

async function setupTest() {
  let box: BoxIdentity = { identity: 'cloud:0123456789abcdef' };

  const buildOptions = (paths: DaemonPaths) => {
    const fakeClaude = createStubEchoClaude(paths.directory);

    return {
      adapter: buildMockAgentAdapter({ planSpawn: () => ({ bin: fakeClaude, args: [] }) }),
      targets: [
        {
          id: 'box',
          kind: 'cloud',
          options: {},
          ...box,
          label: 'cloud',
          placeParts: {
            scope: 'shared' as const,
            version: 'place-v1',
            parts: { url: 'https://svc.example.dev' },
          },
          provider: buildStubMemoryProvider({
            kind: 'cloud',
            capabilities: { destroy: true },
          }),
        },
        {
          id: 'plain',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: buildStubMemoryProvider({ kind: 'local-pty' }),
        },
      ],
      defaultTarget: 'plain',
    };
  };

  const daemon = await startTestDaemon({ options: buildOptions });

  const spawn = (target: string, extra: Record<string, unknown> = {}) =>
    daemon.client.sendRequest('session.spawn', {
      cwd: daemon.directory,
      cols: 80,
      rows: 24,
      target,
      ...extra,
    });

  const restartAndRestore = async (next: BoxIdentity) => {
    box = next;

    await daemon.restart(buildOptions);

    const client = await daemon.openClient();

    await client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

    return client;
  };

  return { ...daemon, spawn, restartAndRestore };
}

test('it answers session.spawn with the place of a shared target and a host the spawn made', async () => {
  const ctx = await setupTest();
  const spawned = await ctx.spawn('box');

  expect(getRecord(spawned, 'session')).toMatchObject({
    place: { key: 'cloud:place-v1:534c6df68a693f9c', label: 'cloud' },
    canDestroyHost: true,
  });
});

test('it answers session.get and session.list with the place', async () => {
  const ctx = await setupTest();
  const spawned = await ctx.spawn('box');

  const id = getRecord(spawned, 'session')['id'];

  const got = await ctx.client.sendRequest('session.get', { session: id });
  const listed = await ctx.client.sendRequest('session.list', {});

  expect(getRecord(got, 'session')).toMatchObject({
    place: { key: 'cloud:place-v1:534c6df68a693f9c', label: 'cloud' },
    canDestroyHost: true,
  });

  expect(JSON.stringify(listed)).toContain('cloud:place-v1:534c6df68a693f9c');
});

test('it gives a target with no place rule a daemon place labelled by its id', async () => {
  const ctx = await setupTest();
  const spawned = await ctx.spawn('plain');

  const session = getRecord(spawned, 'session');

  expect(session['place']).toStrictEqual({
    key: expect.stringMatching(/^daemon:.+:plain$/u),
    label: 'plain',
  });

  expect(session['canDestroyHost']).toBe(false);
});

test('it sends the place in the SessionAdded event', async () => {
  const ctx = await setupTest();

  await ctx.spawn('box');

  const added = await waitForEvent(ctx.events, { ev: 'SessionAdded' });

  expect(added).toMatchObject({
    session: {
      place: { key: 'cloud:place-v1:534c6df68a693f9c', label: 'cloud' },
      canDestroyHost: true,
    },
  });
});

test('it reports canDestroyHost false for a sub-session on the host its parent made', async () => {
  const ctx = await setupTest();
  const parent = await ctx.spawn('box');
  const child = await ctx.spawn('box', { parent: getRecord(parent, 'session')['id'] });

  expect(getRecord(child, 'session')).toMatchObject({
    place: { key: 'cloud:place-v1:534c6df68a693f9c', label: 'cloud' },
    canDestroyHost: false,
  });
});

test('it reports canDestroyHost false after a restart for a session whose target changed, since forget refuses it', async () => {
  const ctx = await setupTest();
  const spawned = await ctx.spawn('box');
  const client = await ctx.restartAndRestore({ identity: 'cloud:changed' });

  const got = await client.sendRequest('session.get', {
    session: getRecord(spawned, 'session')['id'],
  });

  const restored = getRecord(got, 'session');

  expect({ place: restored['place'], canDestroyHost: restored['canDestroyHost'] }).toStrictEqual({
    place: {
      key: expect.stringMatching(/^daemon:[^:]+:box:cloud%3A0123456789abcdef$/u),
      label: 'cloud',
    },
    canDestroyHost: false,
  });
});

test('it keeps a session out of its target place after a restart that could not confirm its unversioned binding', async () => {
  const ctx = await setupTest();
  const spawned = await ctx.spawn('box');

  const client = await ctx.restartAndRestore({
    identity: 'cloud:reach-v1:fedcba9876543210',
    identityRule: { version: 'reach-v1', ignoredOptions: [] },
  });

  const got = await client.sendRequest('session.get', {
    session: getRecord(spawned, 'session')['id'],
  });

  const restored = getRecord(got, 'session');

  expect({ place: restored['place'], canDestroyHost: restored['canDestroyHost'] }).toStrictEqual({
    place: {
      key: expect.stringMatching(/^daemon:[^:]+:box:cloud%3A0123456789abcdef$/u),
      label: 'cloud',
    },
    canDestroyHost: false,
  });
});
