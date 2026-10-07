import { expect, mock, onTestFinished, test } from 'bun:test';
import { buildTargetIdentity } from '../daemon/build-target-identity';
import { LocalPTYProvider } from '../daemon/local-pty-provider';
import { buildStubTargets } from './build-stub-targets';
import { setupTempDir } from './setup-temp-dir';

function setupTest() {
  return setupTempDir('atc-stub-targets-');
}

test('it builds a target with a provider for each local-pty entry and none for another kind', () => {
  const [local, box] = buildStubTargets(
    [
      { id: 'local', provider: 'local-pty', options: {} },
      { id: 'box', provider: 'imp', options: { size: 2 } },
    ],
    { spawned: [] },
  );

  expect(local).toStrictEqual({
    id: 'local',
    kind: 'local-pty',
    options: {},
    identity: buildTargetIdentity('local-pty', {}),
    provider: {
      kind: 'local-pty',
      remote: false,
      capabilities: new LocalPTYProvider().capabilities,
      prepareHost: expect.toBeFunction(),
      spawnHarness: expect.toBeFunction(),
      transferArchive: expect.toBeFunction(),
      runCommand: expect.toBeFunction(),
      suspendHost: expect.toBeFunction(),
      destroyHost: expect.toBeFunction(),
      dispose: expect.toBeFunction(),
    },
  });

  expect(box).toStrictEqual({
    id: 'box',
    kind: 'imp',
    options: { size: 2 },
    identity: buildTargetIdentity('imp', { size: 2 }),
    provider: null,
  });
});

test('it records the target of each spawn', () => {
  using ctx = setupTest();

  const spawned: string[] = [];

  const [target] = buildStubTargets([{ id: 'box', provider: 'local-pty', options: {} }], {
    spawned,
  });

  const harness = target?.provider?.spawnHarness({
    session: 's-1',
    host: 's-1',
    bin: 'true',
    args: [],
    cwd: ctx.dir,
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

  expect(target?.provider?.capabilities.suspend).toBeTrue();
  expect(suspendHost).toHaveBeenCalledExactlyOnceWith('h-1');
});
