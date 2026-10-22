import { expect, mock, test } from 'bun:test';
import type { ExecutionProvider, HarnessExit } from '@atc/plugin-api';
import { buildStubClock } from '@atc/test-utils';
import { buildStubCredentialBroker } from './build-stub-credential-broker';
import { buildStubMemoryProvider } from './build-stub-memory-provider';

test('it builds a provider with the capabilities of a local pseudo-terminal by default', () => {
  const provider = buildStubMemoryProvider();

  expect(provider.kind).toBe('memory');
  expect(provider.remote).toBeFalse();

  expect(provider.capabilities).toStrictEqual({
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
  });
});

test('it applies the kind, remoteness, capabilities, guest, and broker the config gives', async () => {
  const broker = buildStubCredentialBroker();

  const provider = buildStubMemoryProvider({
    kind: 'imp',
    remote: true,
    capabilities: { suspend: true, input: false },
    guest: { directory: '/guest', atc: null },
    brokerAuth: broker,
  });

  const guest = await provider.readGuest?.('s-1');

  expect(provider.kind).toBe('imp');
  expect(provider.remote).toBeTrue();
  expect(provider.capabilities.suspend).toBeTrue();
  expect(provider.capabilities.input).toBeFalse();
  expect(guest).toStrictEqual({ directory: '/guest', atc: null });
  expect(provider.brokerAuth).toBe(broker);
});

test('it holds no guest layout and no broker when the config gives none', () => {
  const provider = buildStubMemoryProvider();

  expect(provider).not.toContainAnyKeys(['readGuest', 'brokerAuth']);
});

test('it applies the workspace flags the config gives', () => {
  const provider = buildStubMemoryProvider({
    cloneOnTarget: false,
    hostGitIdentity: true,
    guestWorkspaceTrust: true,
  });

  expect(provider).toContainEntries([
    ['cloneOnTarget', false],
    ['hostGitIdentity', true],
    ['guestWorkspaceTrust', true],
  ]);
});

test('it holds no workspace flag when the config gives none', () => {
  const provider = buildStubMemoryProvider();

  expect(provider).not.toContainAnyKeys([
    'cloneOnTarget',
    'hostGitIdentity',
    'guestWorkspaceTrust',
  ]);
});

test('it records each harness it starts with its spec', () => {
  const provider = buildStubMemoryProvider();

  provider.spawnHarness({
    session: 's-1',
    host: 's-1',
    bin: 'claude',
    args: ['--resume'],
    cwd: '/work',
    env: { TERM: 'xterm' },
    cols: 80,
    rows: 24,
  });

  expect(provider.harnesses.map((harness) => harness.spec)).toStrictEqual([
    {
      session: 's-1',
      host: 's-1',
      bin: 'claude',
      args: ['--resume'],
      cwd: '/work',
      env: { TERM: 'xterm' },
      cols: 80,
      rows: 24,
    },
  ]);
});

test('it starts no harness when the spawn callback throws', () => {
  const provider = buildStubMemoryProvider({
    onSpawn: () => {
      throw new Error('refused');
    },
  });

  expect(() =>
    provider.spawnHarness({
      session: 's-1',
      host: 's-1',
      bin: 'claude',
      args: [],
      cwd: '/work',
      env: {},
      cols: 80,
      rows: 24,
    }),
  ).toThrowWithMessage(Error, 'refused');

  expect(provider.harnesses).toBeEmpty();
});

test('it records what the daemon writes to a harness and each size it sets', () => {
  const provider = buildStubMemoryProvider();

  const harness = provider.spawnHarness({
    session: 's-1',
    host: 's-1',
    bin: 'claude',
    args: [],
    cwd: '/work',
    env: {},
    cols: 80,
    rows: 24,
  });

  harness.write('hello\r');
  harness.resize(120, 40);

  expect(provider.harnesses[0]?.written).toStrictEqual(['hello\r']);
  expect(provider.harnesses[0]?.sizes).toStrictEqual([[120, 40]]);
});

test('it delivers the output a test emits to each listener until it is disposed', () => {
  const provider = buildStubMemoryProvider();
  const kept = mock<(data: string) => void>();
  const dropped = mock<(data: string) => void>();

  const harness = provider.spawnHarness({
    session: 's-1',
    host: 's-1',
    bin: 'claude',
    args: [],
    cwd: '/work',
    env: {},
    cols: 80,
    rows: 24,
  });

  harness.onData(kept);
  harness.onData(dropped).dispose();
  provider.harnesses[0]?.emitData('ready');
  expect(kept).toHaveBeenCalledExactlyOnceWith('ready');
  expect(dropped).not.toHaveBeenCalled();
});

test('it reports one exit for a harness that a test ends twice', () => {
  const provider = buildStubMemoryProvider();
  const onExit = mock<(exit: HarnessExit) => void>();

  const harness = provider.spawnHarness({
    session: 's-1',
    host: 's-1',
    bin: 'claude',
    args: [],
    cwd: '/work',
    env: {},
    cols: 80,
    rows: 24,
  });

  harness.onExit(onExit);
  provider.harnesses[0]?.emitExit({ exitCode: 3 });
  provider.harnesses[0]?.emitExit({ exitCode: 4 });
  expect(onExit).toHaveBeenCalledExactlyOnceWith({ exitCode: 3 });
  expect(provider.harnesses[0]?.readExit()).toStrictEqual({ exitCode: 3 });
});

test('it ends a killed harness with exit code 0 once the kill returns', async () => {
  const provider = buildStubMemoryProvider();
  const onExit = mock<(exit: HarnessExit) => void>();

  const harness = provider.spawnHarness({
    session: 's-1',
    host: 's-1',
    bin: 'claude',
    args: [],
    cwd: '/work',
    env: {},
    cols: 80,
    rows: 24,
  });

  harness.onExit(onExit);
  harness.kill();

  const exitedAtKill = onExit.mock.calls.length;

  const exited = await harness.waitForExit(1000);

  expect(exited).toBeTrue();
  expect(exitedAtKill).toBe(0);
  expect(onExit).toHaveBeenCalledExactlyOnceWith({ exitCode: 0 });
});

test('it ends a force-killed harness with exit code 137', async () => {
  const provider = buildStubMemoryProvider();

  const harness = provider.spawnHarness({
    session: 's-1',
    host: 's-1',
    bin: 'claude',
    args: [],
    cwd: '/work',
    env: {},
    cols: 80,
    rows: 24,
  });

  harness.killForced?.();

  const exited = await harness.waitForExit(1000);

  expect(exited).toBeTrue();
  expect(provider.harnesses[0]?.readExit()).toStrictEqual({ exitCode: 137 });
});

test('it reports no exit for a harness that runs past the wait', async () => {
  const clock = buildStubClock(0);
  const provider = buildStubMemoryProvider({ clock });

  const harness = provider.spawnHarness({
    session: 's-1',
    host: 's-1',
    bin: 'claude',
    args: [],
    cwd: '/work',
    env: {},
    cols: 80,
    rows: 24,
  });

  const wait = harness.waitForExit(1000);

  clock.advance(999);

  const pending = Bun.peek.status(wait);

  clock.advance(1);

  const exited = await wait;

  expect(pending).toBe('pending');
  expect(exited).toBeFalse();
});

test('it leaves a detached harness running and tells no listener of its later exit', async () => {
  const provider = buildStubMemoryProvider();
  const onData = mock<(data: string) => void>();
  const onExit = mock<(exit: HarnessExit) => void>();

  const harness = provider.spawnHarness({
    session: 's-1',
    host: 's-1',
    bin: 'claude',
    args: [],
    cwd: '/work',
    env: {},
    cols: 80,
    rows: 24,
  });

  harness.onData(onData);
  harness.onExit(onExit);

  const wait = harness.waitForExit(1000);

  harness.detach();
  provider.harnesses[0]?.emitData('late');
  provider.harnesses[0]?.emitExit({ exitCode: 0 });

  const exited = await wait;

  expect(exited).toBeFalse();
  expect(provider.harnesses[0]?.isDetached()).toBeTrue();
  expect(provider.harnesses[0]?.readExit()).toBeNull();
  expect(onData).not.toHaveBeenCalled();
  expect(onExit).not.toHaveBeenCalled();
});

test('it records each archive transfer with its host', async () => {
  const provider = buildStubMemoryProvider();

  const archive = new Uint8Array([1, 2, 3]);

  await provider.transferArchive(archive, '/work');
  await provider.transferArchive(archive, '/guest/work', 'box');

  expect(provider.transfers).toStrictEqual([
    { archive, directory: '/work' },
    { archive, directory: '/guest/work', host: 'box' },
  ]);
});

test('it records an archive transfer and then unpacks it through the config', async () => {
  const transferArchive = mock<ExecutionProvider['transferArchive']>(() => Promise.resolve());
  const provider = buildStubMemoryProvider({ transferArchive });

  const archive = new Uint8Array([1, 2, 3]);

  await provider.transferArchive(archive, '/guest/work', 'box');

  expect(provider.transfers).toStrictEqual([{ archive, directory: '/guest/work', host: 'box' }]);
  expect(transferArchive).toHaveBeenCalledExactlyOnceWith(archive, '/guest/work', 'box');
});

test('it answers every command with a clean exit when the config gives no answer', async () => {
  const provider = buildStubMemoryProvider();

  const result = await provider.runCommand({ argv: ['git', 'status'], cwd: '/work' });

  expect(result).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });
  expect(provider.commands).toStrictEqual([{ argv: ['git', 'status'], cwd: '/work' }]);
});

test('it answers each command through the config', async () => {
  const provider = buildStubMemoryProvider({
    runCommand: (spec) =>
      Promise.resolve({ exitCode: 1, stdout: spec.argv.join(' '), stderr: 'failed' }),
  });

  const result = await provider.runCommand({ argv: ['git', 'status'], cwd: '/work', host: 'box' });

  expect(result).toStrictEqual({ exitCode: 1, stdout: 'git status', stderr: 'failed' });
});

test('it records each host it readies, puts to sleep, and destroys', async () => {
  const provider = buildStubMemoryProvider();

  await provider.prepareHost({ host: 'box', daemonID: 'd-1' });
  await provider.suspendHost('box');
  await provider.destroyHost('box');

  expect(provider.prepared).toStrictEqual([{ host: 'box', daemonID: 'd-1' }]);
  expect(provider.suspended).toStrictEqual(['box']);
  expect(provider.destroyed).toStrictEqual(['box']);
});

test('it records a host operation and then rejects with the config operation refusal', () => {
  const provider = buildStubMemoryProvider({
    prepareHost: () => Promise.reject(new Error('no capacity')),
    suspendHost: () => Promise.reject(new Error('leased')),
    destroyHost: () => Promise.reject(new Error('gone')),
  });

  expect(provider.prepareHost({ host: 'box', daemonID: 'd-1' })).rejects.toThrow('no capacity');
  expect(provider.suspendHost('box')).rejects.toThrow('leased');
  expect(provider.destroyHost('box')).rejects.toThrow('gone');
  expect(provider.prepared).toStrictEqual([{ host: 'box', daemonID: 'd-1' }]);
  expect(provider.suspended).toStrictEqual(['box']);
  expect(provider.destroyed).toStrictEqual(['box']);
});

test('it passes the idle check of a sleep to the config operation', async () => {
  const suspendHost = mock(() => Promise.resolve());
  const provider = buildStubMemoryProvider({ suspendHost });
  const isIdle = mock(() => true);

  await provider.suspendHost('box', isIdle);

  expect(suspendHost).toHaveBeenCalledExactlyOnceWith('box', isIdle);
});

test('it counts each disposal', async () => {
  const provider = buildStubMemoryProvider();

  await provider.dispose();
  await provider.dispose();

  expect(provider.countDisposals()).toBe(2);
});
