import { expect, mock, onTestFinished, test } from 'bun:test';
import { LocalPTYProvider } from '../daemon/local-pty-provider';
import { buildStubPTYProvider } from './build-stub-pty-provider';
import { setupTempDir } from './setup-temp-dir';
import { waitFor } from './wait-for';

test('it reports the local provider kind and capabilities by default', () => {
  const provider = buildStubPTYProvider();

  expect({ kind: provider.kind, capabilities: provider.capabilities }).toStrictEqual({
    kind: 'local-pty',
    capabilities: new LocalPTYProvider().capabilities,
  });
});

test('it reports the kind and capabilities the test gives it', () => {
  const provider = buildStubPTYProvider({ kind: 'imp', capabilities: { suspend: true } });

  expect({ kind: provider.kind, capabilities: provider.capabilities }).toStrictEqual({
    kind: 'imp',
    capabilities: { ...new LocalPTYProvider().capabilities, suspend: true },
  });
});

test('it reports each spec and runs the harness on a real terminal', async () => {
  using tmp = setupTempDir('atc-stub-pty-provider-');

  const onSpawn = mock(() => {});
  const provider = buildStubPTYProvider({ onSpawn });
  const output: string[] = [];

  const spec = {
    session: 's-1',
    host: 's-1',
    bin: 'printf',
    args: ['stub-harness-ran'],
    cwd: tmp.dir,
    env: {},
    cols: 80,
    rows: 24,
  };

  const harness = provider.spawnHarness(spec);

  onTestFinished(() => {
    harness.kill();
  });

  harness.onData((data) => {
    output.push(data);
  });

  await waitFor(() => {
    expect(output.join('')).toInclude('stub-harness-ran');
  });

  expect(onSpawn).toHaveBeenCalledExactlyOnceWith(spec);
});

test('it takes the host operations the test gives it', async () => {
  const prepareHost = mock(() => Promise.resolve());
  const suspendHost = mock(() => Promise.resolve());
  const destroyHost = mock(() => Promise.resolve());
  const provider = buildStubPTYProvider({ prepareHost, suspendHost, destroyHost });

  await provider.prepareHost({ host: 'h-1', daemonID: 'd-1' });
  await provider.suspendHost('h-1');
  await provider.destroyHost('h-1');

  expect(prepareHost).toHaveBeenCalledExactlyOnceWith({ host: 'h-1', daemonID: 'd-1' });
  expect(suspendHost).toHaveBeenCalledExactlyOnceWith('h-1');
  expect(destroyHost).toHaveBeenCalledExactlyOnceWith('h-1');
});

test('it rejects a sleep as the local provider does when the test gives none', () => {
  expect(buildStubPTYProvider().suspendHost('h-1')).rejects.toThrowWithMessage(
    Error,
    'the local-pty provider cannot suspend host h-1',
  );
});

test('it rejects a destroy as the local provider does when the test gives none', () => {
  expect(buildStubPTYProvider().destroyHost('h-1')).rejects.toThrowWithMessage(
    Error,
    'the local-pty provider cannot destroy host h-1',
  );
});
