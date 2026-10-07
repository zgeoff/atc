import { expect, test } from 'bun:test';
import { buildStubHostProvider } from './build-stub-host-provider';
import { setupTempDir } from './setup-temp-dir';

function setupTest() {
  return setupTempDir('atc-stub-host-');
}

test('it declares every capability of a local terminal plus sleeping and destroying a host', () => {
  expect(buildStubHostProvider().capabilities).toStrictEqual({
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
  using ctx = setupTest();

  expect(
    buildStubHostProvider().runCommand({ argv: ['pwd'], cwd: ctx.dir }),
  ).resolves.toStrictEqual({ exitCode: 0, stdout: `${ctx.dir}\n`, stderr: '' });
});

test('it puts a host to sleep without doing anything', () => {
  expect(buildStubHostProvider().suspendHost('s-1')).resolves.toBeUndefined();
});

test('it destroys a host without doing anything', () => {
  expect(buildStubHostProvider().destroyHost('s-1')).resolves.toBeUndefined();
});
