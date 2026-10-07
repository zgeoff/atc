import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubHeldZoxide } from './build-stub-held-zoxide';
import { createStubBin } from './create-stub-bin';
import { setupTempDir } from './setup-temp-dir';
import { waitFor } from './wait-for';

function setupTest() {
  using stack = new DisposableStack();

  const tmp = stack.use(setupTempDir('atc-stub-held-zoxide-'));
  const zoxide = createStubBin(tmp.dir, 'zoxide', buildStubHeldZoxide());
  const owned = stack.move();

  return {
    dir: tmp.dir,
    zoxide,
    [Symbol.dispose]: () => {
      owned.dispose();
    },
  };
}

test('it lists no directories at once when no hold file exists', () => {
  using ctx = setupTest();

  const result = Bun.spawnSync([ctx.zoxide, 'query', '-l'], {
    env: { HOME: ctx.dir, PATH: '/usr/bin:/bin' },
  });

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: '',
  });
});

test('it holds the listing until the hold file goes', async () => {
  using ctx = setupTest();

  writeFileSync(join(ctx.dir, 'zoxide-hold'), '');

  const proc = Bun.spawn([ctx.zoxide, 'query', '-l'], {
    env: { HOME: ctx.dir, PATH: '/usr/bin:/bin' },
  });

  onTestFinished(() => {
    proc.kill();
  });

  await waitFor(() => {
    expect(existsSync(join(ctx.dir, 'zoxide-held'))).toBe(true);
  });

  const exitedWhileHeld = proc.exitCode;

  rmSync(join(ctx.dir, 'zoxide-hold'));

  const exitCode = await proc.exited;

  expect({ exitedWhileHeld, exitCode }).toStrictEqual({ exitedWhileHeld: null, exitCode: 0 });
});
