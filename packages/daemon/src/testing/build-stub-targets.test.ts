import { expect, mock, test } from 'bun:test';
import { buildStubTargets } from './build-stub-targets';

test('it builds a target with an in-memory provider for each local-pty entry and none for another kind', () => {
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
    identity: 'local-pty:44136fa355b3678a',
  });

  expect(local?.provider).toMatchObject({ kind: 'local-pty', remote: false, harnesses: [] });

  expect(box).toStrictEqual({
    id: 'box',
    kind: 'imp',
    options: { size: 2 },
    identity: 'imp:7028e13f78f6f7ad',
    provider: null,
  });
});

test('it records the target of each spawn', () => {
  const spawned: string[] = [];

  const [target] = buildStubTargets([{ id: 'box', provider: 'local-pty', options: {} }], {
    spawned,
  });

  target?.provider?.spawnHarness({
    session: 's-1',
    host: 's-1',
    bin: 'stub-harness',
    args: [],
    cwd: '/work',
    env: {},
    cols: 80,
    rows: 24,
  });

  expect(spawned).toStrictEqual(['box']);
});

test('it runs the start callback on each harness a local-pty target starts', () => {
  const onStart = mock(() => {});

  const [target] = buildStubTargets([{ id: 'box', provider: 'local-pty', options: {} }], {
    spawned: [],
    onStart,
  });

  const harness = target?.provider?.spawnHarness({
    session: 's-1',
    host: 's-1',
    bin: 'stub-harness',
    args: [],
    cwd: '/work',
    env: {},
    cols: 80,
    rows: 24,
  });

  expect(onStart).toHaveBeenCalledExactlyOnceWith(harness);
});

test('it gives a target the host operations named for it', async () => {
  const suspendHost = mock(() => Promise.resolve());

  const [target] = buildStubTargets([{ id: 'box', provider: 'local-pty', options: {} }], {
    spawned: [],
    hosts: { box: { suspendHost, capabilities: { suspend: true } } },
  });

  await target?.provider?.suspendHost('h-1');

  expect(target?.provider?.capabilities.suspend).toBeTrue();
  expect(suspendHost).toHaveBeenCalledExactlyOnceWith('h-1', undefined);
});
