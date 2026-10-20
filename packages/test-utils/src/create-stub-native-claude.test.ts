import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { createStubNativeClaude } from './create-stub-native-claude';
import { runCommand } from './run-command';
import { setupTempDir } from './setup-temp-dir';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-stub-native-claude-');

  return { directory: temporaryDirectory.path };
}

test('it returns the program path under the directory, which it creates', async () => {
  const ctx = setupTest();

  const path = await createStubNativeClaude(join(ctx.directory, 'bin'), 'claude');

  expect(path).toBe(join(ctx.directory, 'bin', 'claude'));
});

test('it builds a program that prints the DYLD_ATC_TEST value it starts with', async () => {
  const ctx = setupTest();

  const path = await createStubNativeClaude(ctx.directory, 'claude');

  const result = await runCommand([path, '--settings', 'ignored'], {
    env: { DYLD_ATC_TEST: 'synthetic' },
  });

  expect(result.stdout).toBe('FAKE_NATIVE_DYLD:[synthetic]\n');
});

test('it builds a program that prints unset when it starts without DYLD_ATC_TEST', async () => {
  const ctx = setupTest();

  const path = await createStubNativeClaude(ctx.directory, 'claude');
  const result = await runCommand([path], { env: {} });

  expect(result.stdout).toBe('FAKE_NATIVE_DYLD:[unset]\n');
});
