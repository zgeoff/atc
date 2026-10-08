import { expect, test } from 'bun:test';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubHeldZoxide } from './build-stub-held-zoxide';
import { createStubBin } from './create-stub-bin';
import { registerTestCleanup } from './register-test-cleanup';
import { runCommand } from './run-command';
import { setupTempDir } from './setup-temp-dir';
import { waitFor } from './wait-for';

function setupTest() {
  const tmp = setupTempDir('atc-stub-held-zoxide-');
  const zoxide = createStubBin(tmp.dir, 'zoxide', buildStubHeldZoxide());

  return {
    dir: tmp.dir,
    zoxide,
  };
}

test('it lists no directories at once when no hold file exists', async () => {
  const ctx = setupTest();

  const result = await runCommand([ctx.zoxide, 'query', '-l'], {
    env: { HOME: ctx.dir, PATH: '/usr/bin:/bin' },
  });

  expect({ exitCode: result.exitCode, stdout: result.stdout }).toStrictEqual({
    exitCode: 0,
    stdout: '',
  });
});

test('it holds the listing until the hold file goes', async () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'zoxide-hold'), '');

  const proc = Bun.spawn([ctx.zoxide, 'query', '-l'], {
    env: { HOME: ctx.dir, PATH: '/usr/bin:/bin' },
  });

  registerTestCleanup(() => {
    proc.kill();
  });

  await waitFor(() => {
    expect(existsSync(join(ctx.dir, 'zoxide-held'))).toBe(true);
  });

  const statusWhileHeld = Bun.peek.status(proc.exited);

  rmSync(join(ctx.dir, 'zoxide-hold'));

  const exitCode = await proc.exited;

  expect(statusWhileHeld).toBe('pending');
  expect(exitCode).toBe(0);
});
