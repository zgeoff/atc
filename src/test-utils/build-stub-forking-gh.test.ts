import { expect, onTestFinished, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildStubForkingGH } from './build-stub-forking-gh';
import { createStubBin } from './create-stub-bin';
import { setupTempDir } from './setup-temp-dir';
import { waitFor } from './wait-for';

function setupTest() {
  return setupTempDir('atc-stub-forking-gh-');
}

test('it records its own ID and the ID of a child that is still running', async () => {
  using ctx = setupTest();

  const pidsFile = join(ctx.dir, 'pids');
  const gh = createStubBin(ctx.dir, 'gh', buildStubForkingGH(pidsFile));
  const proc = Bun.spawn([gh, 'repo', 'list'], { detached: true });

  onTestFinished(() => {
    process.kill(-proc.pid, 'SIGKILL');
  });

  const pids = await waitFor(() => readFile(pidsFile, 'utf8'));

  const [own, child] = pids.trim().split('\n').map(Number);

  if (child === undefined) {
    throw new Error('the stand-in recorded no child');
  }

  expect({ own, childRunning: process.kill(child, 0) }).toStrictEqual({
    own: proc.pid,
    childRunning: true,
  });
});

test('it keeps running until it is killed', async () => {
  using ctx = setupTest();

  const pidsFile = join(ctx.dir, 'pids');
  const gh = createStubBin(ctx.dir, 'gh', buildStubForkingGH(pidsFile));
  const proc = Bun.spawn([gh, 'repo', 'list'], { detached: true });

  onTestFinished(() => {
    process.kill(-proc.pid, 'SIGKILL');
  });

  await waitFor(() => readFile(pidsFile, 'utf8'));

  expect(proc.exitCode).toBeNull();
});
