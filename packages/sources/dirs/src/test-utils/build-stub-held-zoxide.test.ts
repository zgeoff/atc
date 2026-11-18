import { expect, test } from 'bun:test';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStubBin } from '@atc/core/test-utils/create-stub-bin';
import { registerTestCleanup } from '@atc/core/test-utils/register-test-cleanup';
import { runCommand } from '@atc/core/test-utils/run-command';
import { setupTempDir } from '@atc/core/test-utils/setup-temp-dir';
import { waitFor } from '@atc/core/test-utils/wait-for';
import { buildStubHeldZoxide } from './build-stub-held-zoxide';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-stub-held-zoxide-');
  const zoxide = createStubBin(temporaryDirectory.path, 'zoxide', buildStubHeldZoxide());

  return {
    directory: temporaryDirectory.path,
    zoxide,
  };
}

test('it lists no directories at once when no hold file exists', async () => {
  const ctx = setupTest();

  const result = await runCommand([ctx.zoxide, 'query', '-l'], {
    env: { HOME: ctx.directory, PATH: '/usr/bin:/bin' },
  });

  expect({ exitCode: result.exitCode, stdout: result.stdout }).toStrictEqual({
    exitCode: 0,
    stdout: '',
  });
});

test('it holds the listing until the hold file goes', async () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directory, 'zoxide-hold'), '');

  const subprocess = Bun.spawn([ctx.zoxide, 'query', '-l'], {
    env: { HOME: ctx.directory, PATH: '/usr/bin:/bin' },
  });

  registerTestCleanup(() => {
    subprocess.kill();
  });

  await waitFor(() => {
    expect(existsSync(join(ctx.directory, 'zoxide-held'))).toBe(true);
  });

  const statusWhileHeld = Bun.peek.status(subprocess.exited);

  rmSync(join(ctx.directory, 'zoxide-hold'));

  const exitCode = await subprocess.exited;

  expect(statusWhileHeld).toBe('pending');
  expect(exitCode).toBe(0);
});
