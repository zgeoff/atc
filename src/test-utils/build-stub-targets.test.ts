import { expect, mock, onTestFinished, test } from 'bun:test';
import { buildTargetIdentity } from '../daemon/build-target-identity';
import { buildStubTargets } from './build-stub-targets';
import { setupTempDir } from './setup-temp-dir';

test('it builds a target with a provider for each local-pty entry and none for another kind', () => {
  const [local, box] = buildStubTargets(
    [
      { id: 'local', provider: 'local-pty', options: {} },
      { id: 'box', provider: 'imp', options: { size: 2 } },
    ],
    { spawned: [] },
  );

  expect(local).toMatchObject({
    id: 'local',
    kind: 'local-pty',
    options: {},
    identity: buildTargetIdentity('local-pty', {}),
  });

  expect(local?.provider?.kind).toBe('local-pty');

  expect(box).toStrictEqual({
    id: 'box',
    kind: 'imp',
    options: { size: 2 },
    identity: buildTargetIdentity('imp', { size: 2 }),
    provider: null,
  });
});

test('it records the target of each spawn', () => {
  using tmp = setupTempDir('atc-stub-targets-');

  const spawned: string[] = [];

  const [target] = buildStubTargets([{ id: 'box', provider: 'local-pty', options: {} }], {
    spawned,
  });

  const harness = target?.provider?.spawnHarness({
    session: 's-1',
    host: 's-1',
    bin: 'true',
    args: [],
    cwd: tmp.dir,
    env: {},
    cols: 80,
    rows: 24,
  });

  onTestFinished(() => {
    harness?.kill();
  });

  expect(spawned).toStrictEqual(['box']);
});

test('it gives a target the host operations named for it', async () => {
  const suspendHost = mock(() => Promise.resolve());

  const [target] = buildStubTargets([{ id: 'box', provider: 'local-pty', options: {} }], {
    spawned: [],
    hosts: { box: { suspendHost, capabilities: { suspend: true } } },
  });

  await target?.provider?.suspendHost('h-1');

  expect({
    suspend: target?.provider?.capabilities.suspend,
    calls: suspendHost.mock.calls.length,
  }).toStrictEqual({ suspend: true, calls: 1 });
});
