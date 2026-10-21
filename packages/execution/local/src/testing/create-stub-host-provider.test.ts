import { expect, test } from 'bun:test';
import { setupTempDir } from '@atc/test-utils';
import { createStubHostProvider } from './create-stub-host-provider';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-stub-host-');

  return { directory: temporaryDirectory.path };
}

test('it declares every capability of a local terminal plus sleeping and destroying a host', () => {
  expect(createStubHostProvider().capabilities).toStrictEqual({
    spawn: true,
    attach: true,
    input: true,
    resize: true,
    kill: true,
    transfer: true,
    run: true,
    headless: true,
    suspend: true,
    destroy: true,
  });
});

test('it runs a command on this machine', () => {
  const ctx = setupTest();

  expect(
    createStubHostProvider().runCommand({ argv: ['pwd'], cwd: ctx.directory }),
  ).resolves.toStrictEqual({ exitCode: 0, stdout: `${ctx.directory}\n`, stderr: '' });
});

test('it puts a host to sleep without doing anything', () => {
  expect(createStubHostProvider().suspendHost('s-1')).resolves.toBeUndefined();
});

test('it destroys a host without doing anything', () => {
  expect(createStubHostProvider().destroyHost('s-1')).resolves.toBeUndefined();
});
