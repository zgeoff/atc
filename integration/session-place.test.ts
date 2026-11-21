import { expect, test } from 'bun:test';
import { startTestDaemon } from '@atc/app/test-utils/start-test-daemon';
import { getRecord } from '@atc/core/test-utils/get-record';
import { buildStubMemoryProvider } from '@atc/daemon/test-utils/build-stub-memory-provider';
import { createStubEchoClaude } from '@atc/harness-claude/test-utils/create-stub-echo-claude';
import { buildMockAgentAdapter } from '@atc/plugin-api/test-utils/build-mock-agent-adapter';
import { waitForEvent } from '@atc/protocol/test-utils/wait-for-event';

async function setupTest() {
  const daemon = await startTestDaemon({
    options: (paths) => {
      const fakeClaude = createStubEchoClaude(paths.directory);

      return {
        adapter: buildMockAgentAdapter({ planSpawn: () => ({ bin: fakeClaude, args: [] }) }),
        targets: [
          {
            id: 'box',
            kind: 'cloud',
            options: {},
            identity: 'cloud:test',
            label: 'cloud',
            placeParts: {
              scope: 'shared',
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
    },
  });

  const spawn = (target: string, extra: Record<string, unknown> = {}) =>
    daemon.client.sendRequest('session.spawn', {
      cwd: daemon.directory,
      cols: 80,
      rows: 24,
      target,
      ...extra,
    });

  return { ...daemon, spawn };
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
