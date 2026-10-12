import { expect, mock, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { LocalPTYProvider } from '../daemon/local-pty-provider';
import { buildStubExecutionProvider } from './build-stub-execution-provider';
import { registerTestCleanup } from './register-test-cleanup';
import { setupTempDir } from './setup-temp-dir';
import { waitFor } from './wait-for';

function setupTest() {
  const tmp = setupTempDir('atc-stub-provider-');

  return { dir: tmp.dir };
}

test('it builds a provider with the capabilities of a local pseudo-terminal', () => {
  expect(buildStubExecutionProvider()).toStrictEqual({
    kind: 'stub',
    remote: false,
    capabilities: new LocalPTYProvider().capabilities,
    prepareHost: expect.toBeFunction(),
    spawnHarness: expect.toBeFunction(),
    transferArchive: expect.toBeFunction(),
    runCommand: expect.toBeFunction(),
    suspendHost: expect.toBeFunction(),
    destroyHost: expect.toBeFunction(),
    dispose: expect.toBeFunction(),
    suspended: [],
    destroyed: [],
    setSuspendFailure: expect.toBeFunction(),
    setDestroyFailure: expect.toBeFunction(),
  });
});

test('it applies the kind and capability overrides on top of the defaults', () => {
  const provider = buildStubExecutionProvider({
    kind: 'imp-like',
    capabilities: { suspend: true, destroy: true, input: false },
  });

  expect(provider.kind).toBe('imp-like');

  expect(provider.capabilities).toStrictEqual({
    ...new LocalPTYProvider().capabilities,
    suspend: true,
    destroy: true,
    input: false,
  });
});

test('it reports the host as remote once the config marks it so', () => {
  expect(buildStubExecutionProvider({ remote: true }).remote).toBeTrue();
});

test('it rejects every command with the configured failure without running it', async () => {
  const ctx = setupTest();
  const marker = join(ctx.dir, 'ran');

  const failure = new Error('the host runs no commands');

  const provider = buildStubExecutionProvider({ commandFailure: failure });
  const run = provider.runCommand({ argv: ['touch', marker], cwd: ctx.dir });

  await Promise.allSettled([run]);

  expect(run).rejects.toBe(failure);
  expect(existsSync(marker)).toBeFalse();
});

test('it runs a command on this machine', () => {
  const ctx = setupTest();
  const provider = buildStubExecutionProvider();

  expect(provider.runCommand({ argv: ['pwd'], cwd: ctx.dir })).resolves.toStrictEqual({
    exitCode: 0,
    stdout: `${ctx.dir}\n`,
    stderr: '',
  });
});

test('it records each suspended and destroyed host in order', async () => {
  const provider = buildStubExecutionProvider();

  await provider.suspendHost('host-a');
  await provider.destroyHost('host-b');
  await provider.suspendHost('host-c');

  expect(provider.suspended).toStrictEqual(['host-a', 'host-c']);
  expect(provider.destroyed).toStrictEqual(['host-b']);
});

test('it rejects a suspend with the failure it was given and records nothing', () => {
  const provider = buildStubExecutionProvider();

  const failure = new Error('another owner keeps the host awake');

  provider.setSuspendFailure(failure);

  expect(provider.suspendHost('host-a')).rejects.toBe(failure);
  expect(provider.suspended).toBeEmpty();
});

test('it rejects a destroy with the failure it was given and records nothing', () => {
  const provider = buildStubExecutionProvider();

  const failure = new Error('impd is unreachable');

  provider.setDestroyFailure(failure);

  expect(provider.destroyHost('host-a')).rejects.toBe(failure);
  expect(provider.destroyed).toBeEmpty();
});

test('it suspends again once a suspend failure is cleared', async () => {
  const provider = buildStubExecutionProvider();

  const failure = new Error('suspend refused');

  provider.setSuspendFailure(failure);

  const failed = provider.suspendHost('host-a');

  await Promise.allSettled([failed]);

  provider.setSuspendFailure(null);

  await provider.suspendHost('host-a');

  expect(failed).rejects.toBe(failure);
  expect(provider.suspended).toStrictEqual(['host-a']);
});

test('it destroys again once a destroy failure is cleared', async () => {
  const provider = buildStubExecutionProvider();

  const failure = new Error('destroy refused');

  provider.setDestroyFailure(failure);

  const failed = provider.destroyHost('host-a');

  await Promise.allSettled([failed]);

  provider.setDestroyFailure(null);

  await provider.destroyHost('host-a');

  expect(failed).rejects.toBe(failure);
  expect(provider.destroyed).toStrictEqual(['host-a']);
});

test('it reports a harness spec and starts the harness on a local terminal', async () => {
  const ctx = setupTest();
  const onSpawn = mock(() => {});
  const provider = buildStubExecutionProvider({ onSpawn });

  const spec = {
    session: 's1',
    host: 's1',
    bin: 'sh',
    args: ['-c', 'exit 7'],
    cwd: ctx.dir,
    env: {},
    cols: 80,
    rows: 24,
  };

  const exited = Promise.withResolvers<number>();
  const harness = provider.spawnHarness(spec);

  registerTestCleanup(() => {
    harness.kill();
  });

  harness.onExit((exit) => {
    exited.resolve(exit.exitCode);
  });

  const exitCode = await exited.promise;

  expect(onSpawn).toHaveBeenCalledExactlyOnceWith(spec);
  expect(exitCode).toBe(7);
});

test('it aborts the spawn with the error the spawn report throws, before the local start runs', () => {
  const ctx = setupTest();

  const failure = new Error('the harness could not start');

  const provider = buildStubExecutionProvider({
    onSpawn: () => {
      throw failure;
    },
  });

  // The local start refuses a spec that requires a broker with an error of
  // its own before it starts a process, so the error that comes back shows
  // which ran first.
  const spawn = () =>
    provider.spawnHarness({
      session: 's1',
      host: 's1',
      bin: 'sh',
      args: ['-c', 'exit 0'],
      cwd: ctx.dir,
      env: {},
      cols: 80,
      rows: 24,
      requireBroker: true,
    });

  expect(spawn).toThrow(failure);
});

test('it refuses a spec that requires a broker through the local start when the spawn report passes', () => {
  const ctx = setupTest();
  const provider = buildStubExecutionProvider();

  const spawn = () =>
    provider.spawnHarness({
      session: 's1',
      host: 's1',
      bin: 'sh',
      args: ['-c', 'exit 0'],
      cwd: ctx.dir,
      env: {},
      cols: 80,
      rows: 24,
      requireBroker: true,
    });

  expect(spawn).toThrow(
    expect.objectContaining({
      code: 'auth_target_unsupported',
      message: "the daemon's own machine has no credential broker to start the harness behind",
      data: { provider: 'local-pty' },
    }),
  );
});

test('it streams the output of a harness it starts on a local terminal', async () => {
  const ctx = setupTest();
  const provider = buildStubExecutionProvider();

  const harness = provider.spawnHarness({
    session: 's1',
    host: 's1',
    bin: 'sh',
    args: ['-c', 'echo harness-up; exec sleep 30'],
    cwd: ctx.dir,
    env: {},
    cols: 80,
    rows: 24,
  });

  registerTestCleanup(() => {
    harness.kill();
  });

  const output: string[] = [];

  harness.onData((data) => {
    output.push(data);
  });

  await waitFor(() => {
    expect(output.join('')).toInclude('harness-up');
  });
});
