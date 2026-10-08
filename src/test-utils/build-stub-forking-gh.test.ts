import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { buildStubForkingGH } from './build-stub-forking-gh';
import { createStubBin } from './create-stub-bin';
import { registerTestCleanup } from './register-test-cleanup';
import { setupTempDir } from './setup-temp-dir';
import { waitFor } from './wait-for';

function setupTest() {
  const tmp = setupTempDir('atc-stub-forking-gh-');

  return { dir: tmp.dir };
}

test('it records its own ID and the ID of a child that is still running', async () => {
  const ctx = setupTest();
  const pidsFile = join(ctx.dir, 'pids');
  const gh = createStubBin(ctx.dir, 'gh', buildStubForkingGH(pidsFile));
  const proc = Bun.spawn([gh, 'repo', 'list'], { detached: true });

  registerTestCleanup(() => {
    process.kill(-proc.pid, 'SIGKILL');
  });

  const pids = await waitFor(() => readFile(pidsFile, 'utf8'));

  const [own, child] = pids.trim().split('\n').map(Number);

  invariant(child !== undefined, 'the stand-in recorded no child');

  expect(own).toBe(proc.pid);
  expect(process.kill(child, 0)).toBe(true);
});

test('it keeps running after it records the IDs', async () => {
  const ctx = setupTest();
  const pidsFile = join(ctx.dir, 'pids');
  const gh = createStubBin(ctx.dir, 'gh', buildStubForkingGH(pidsFile));
  const proc = Bun.spawn([gh, 'repo', 'list'], { detached: true });

  // kill(1) exits nonzero without throwing once the test's own kill has
  // emptied the group.
  registerTestCleanup(() => {
    Bun.spawnSync(['kill', '-KILL', '--', `-${proc.pid}`]);
  });

  await waitFor(() => readFile(pidsFile, 'utf8'));

  // A stand-in that had already exited by itself dies of no signal.
  process.kill(-proc.pid, 'SIGKILL');

  await proc.exited;

  expect(proc.signalCode).toBe('SIGKILL');
});

test('it stops its child too when its process group is killed', async () => {
  const ctx = setupTest();
  const pidsFile = join(ctx.dir, 'pids');
  const gh = createStubBin(ctx.dir, 'gh', buildStubForkingGH(pidsFile));
  const proc = Bun.spawn([gh, 'repo', 'list'], { detached: true });

  // kill(1) exits nonzero without throwing once the test's own kill has
  // emptied the group.
  registerTestCleanup(() => {
    Bun.spawnSync(['kill', '-KILL', '--', `-${proc.pid}`]);
  });

  const pids = await waitFor(() => readFile(pidsFile, 'utf8'));

  const child = Number(pids.trim().split('\n')[1]);

  process.kill(-proc.pid, 'SIGKILL');

  await proc.exited;

  expect({ exitCode: proc.exitCode, signalCode: proc.signalCode }).toStrictEqual({
    exitCode: null,
    signalCode: 'SIGKILL',
  });

  // The killed child lingers until the kernel reaps it.
  await waitFor(() => {
    expect(() => process.kill(child, 0)).toThrow('ESRCH');
  });
});
