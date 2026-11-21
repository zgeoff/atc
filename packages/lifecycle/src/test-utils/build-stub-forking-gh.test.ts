import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeStubProgram } from '@atc/core/test-utils/write-stub-program';
import { registerTestCleanup, waitFor } from '@zgeoff/testing';
import { createTempDir } from '@zgeoff/testing/fs';
import invariant from 'tiny-invariant';
import { buildStubForkingGH } from './build-stub-forking-gh';

function setupTest() {
  const temporaryDirectory = createTempDir('atc-stub-forking-gh-');

  return { directory: temporaryDirectory.path };
}

test('it records its own ID and the ID of a child that is still running', async () => {
  const ctx = setupTest();
  const pidsFile = join(ctx.directory, 'pids');
  const gh = writeStubProgram(ctx.directory, 'gh', buildStubForkingGH(pidsFile));
  const subprocess = Bun.spawn([gh, 'repo', 'list'], { detached: true });

  registerTestCleanup(() => {
    process.kill(-subprocess.pid, 'SIGKILL');
  });

  const pids = await waitFor(() => readFile(pidsFile, 'utf8'));

  const [own, child] = pids.trim().split('\n').map(Number);

  invariant(child !== undefined, 'the stand-in recorded no child');

  expect(own).toBe(subprocess.pid);
  expect(process.kill(child, 0)).toBe(true);
});

test('it keeps running after it records the IDs', async () => {
  const ctx = setupTest();
  const pidsFile = join(ctx.directory, 'pids');
  const gh = writeStubProgram(ctx.directory, 'gh', buildStubForkingGH(pidsFile));
  const subprocess = Bun.spawn([gh, 'repo', 'list'], { detached: true });

  // kill(1) exits nonzero, without throwing, when the group is already empty.
  registerTestCleanup(async () => {
    await Bun.spawn(['kill', '-KILL', '--', `-${subprocess.pid}`]).exited;
  });

  await waitFor(() => readFile(pidsFile, 'utf8'));

  process.kill(-subprocess.pid, 'SIGKILL');

  await subprocess.exited;

  expect(subprocess.signalCode).toBe('SIGKILL');
});

test('it stops its child too when its process group is killed', async () => {
  const ctx = setupTest();
  const pidsFile = join(ctx.directory, 'pids');
  const gh = writeStubProgram(ctx.directory, 'gh', buildStubForkingGH(pidsFile));
  const subprocess = Bun.spawn([gh, 'repo', 'list'], { detached: true });

  // kill(1) exits nonzero, without throwing, when the group is already empty.
  registerTestCleanup(async () => {
    await Bun.spawn(['kill', '-KILL', '--', `-${subprocess.pid}`]).exited;
  });

  const pids = await waitFor(() => readFile(pidsFile, 'utf8'));

  const child = Number(pids.trim().split('\n')[1]);

  process.kill(-subprocess.pid, 'SIGKILL');

  await subprocess.exited;

  expect({ exitCode: subprocess.exitCode, signalCode: subprocess.signalCode }).toStrictEqual({
    exitCode: null,
    signalCode: 'SIGKILL',
  });

  // The killed child lingers until the kernel reaps it.
  await waitFor(() => {
    expect(() => process.kill(child, 0)).toThrow('ESRCH');
  });
});
