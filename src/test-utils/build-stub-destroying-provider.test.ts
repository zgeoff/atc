import { expect, test } from 'bun:test';
import { LocalPTYProvider } from '../daemon/local-pty-provider';
import { buildStubDestroyingProvider } from './build-stub-destroying-provider';
import { setupTempDir } from './setup-temp-dir';

test('it declares the local capabilities with suspend and destroy besides', () => {
  expect(buildStubDestroyingProvider().capabilities).toStrictEqual({
    ...new LocalPTYProvider().capabilities,
    suspend: true,
    destroy: true,
  });
});

test('it runs on the daemon machine under a provider kind of its own', () => {
  const provider = buildStubDestroyingProvider();

  expect({ kind: provider.kind, remote: provider.remote }).toStrictEqual({
    kind: 'imp-like',
    remote: false,
  });
});

test('it records each host it destroys, in order', async () => {
  const provider = buildStubDestroyingProvider();

  await provider.destroyHost('s-1');
  await provider.destroyHost('s-2');

  expect(provider.destroyed).toStrictEqual(['s-1', 's-2']);
});

test('it suspends a host without destroying it', async () => {
  const provider = buildStubDestroyingProvider();

  await provider.suspendHost('s-1');

  expect(provider.destroyed).toStrictEqual([]);
});

test('it runs a command on the daemon machine', async () => {
  using tmp = setupTempDir('atc-destroying-provider-');

  const result = await buildStubDestroyingProvider().runCommand({
    argv: ['pwd'],
    cwd: tmp.dir,
  });

  expect(result).toStrictEqual({ exitCode: 0, stdout: `${tmp.dir}\n`, stderr: '' });
});
