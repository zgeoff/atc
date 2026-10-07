import { expect, test } from 'bun:test';
import { LocalPTYProvider } from '../daemon/local-pty-provider';
import { buildStubExecutionProvider } from './build-stub-execution-provider';
import { setupTempDir } from './setup-temp-dir';

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

  expect({ kind: provider.kind, capabilities: provider.capabilities }).toStrictEqual({
    kind: 'imp-like',
    capabilities: {
      ...new LocalPTYProvider().capabilities,
      suspend: true,
      destroy: true,
      input: false,
    },
  });
});

test('it runs a command on this machine', () => {
  using tmp = setupTempDir('atc-stub-provider-');

  const provider = buildStubExecutionProvider();

  expect(provider.runCommand({ argv: ['pwd'], cwd: tmp.dir })).resolves.toStrictEqual({
    exitCode: 0,
    stdout: `${tmp.dir}\n`,
    stderr: '',
  });
});

test('it records each suspended and destroyed host in order', async () => {
  const provider = buildStubExecutionProvider();

  await provider.suspendHost('host-a');
  await provider.destroyHost('host-b');
  await provider.suspendHost('host-c');

  expect({ suspended: provider.suspended, destroyed: provider.destroyed }).toStrictEqual({
    suspended: ['host-a', 'host-c'],
    destroyed: ['host-b'],
  });
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

test('it suspends and destroys again once a failure is cleared', async () => {
  const provider = buildStubExecutionProvider();

  provider.setSuspendFailure(new Error('refused'));
  provider.setDestroyFailure(new Error('refused'));

  await Promise.allSettled([provider.suspendHost('host-a'), provider.destroyHost('host-a')]);

  provider.setSuspendFailure(null);
  provider.setDestroyFailure(null);

  await provider.suspendHost('host-a');
  await provider.destroyHost('host-a');

  expect({ suspended: provider.suspended, destroyed: provider.destroyed }).toStrictEqual({
    suspended: ['host-a'],
    destroyed: ['host-a'],
  });
});
