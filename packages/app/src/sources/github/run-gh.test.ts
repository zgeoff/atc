import { expect, test } from 'bun:test';
import { getEventListeners } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { buildStubForkingGH } from '../../test-utils/build-stub-forking-gh';
import { buildStubGH } from '../../test-utils/build-stub-gh';
import { createStubBin } from '../../test-utils/create-stub-bin';
import { registerTestCleanup } from '../../test-utils/register-test-cleanup';
import { setupTempDir } from '../../test-utils/setup-temp-dir';
import { waitFor } from '../../test-utils/wait-for';
import { runGH } from './run-gh';

// A directory for a stand-in gh and the files it records.
function setupTest() {
  const tmp = setupTempDir('atc-run-gh-');

  return { dir: tmp.dir };
}

test('it returns what gh printed and its exit code, and stops listening for an abort', async () => {
  const ctx = setupTest();
  const argvFile = join(ctx.dir, 'argv');

  const gh = createStubBin(
    ctx.dir,
    'gh',
    buildStubGH({ replies: { repo: { stdout: 'out\n', stderr: 'err\n', exitCode: 3 } }, argvFile }),
  );

  const controller = new AbortController();

  const run = await runGH(gh, controller.signal, ['repo', 'list']);
  const argv = await readFile(argvFile, 'utf8');

  expect(run).toStrictEqual({ exitCode: 3, stdout: 'out\n', stderr: 'err\n', timedOut: false });
  expect(argv).toBe('repo list\n');
  expect(getEventListeners(controller.signal, 'abort')).toStrictEqual([]);
});

test('it reports the pid of the gh it starts', async () => {
  const ctx = setupTest();
  const gh = createStubBin(ctx.dir, 'gh', '#!/bin/sh\necho $$\n');
  const spawned: number[] = [];

  const run = await runGH(gh, new AbortController().signal, ['repo', 'list'], {
    onSpawn: (pid) => {
      spawned.push(pid);
    },
  });

  expect(spawned).toStrictEqual([Number(run.stdout.trim())]);
});

test('it stops a gh at once when the signal aborted before the call', async () => {
  const ctx = setupTest();
  const gh = createStubBin(ctx.dir, 'gh', buildStubGH({ replies: { repo: 'hang' } }));
  const spawned: number[] = [];

  const run = await runGH(gh, AbortSignal.abort(), ['repo', 'list'], {
    onSpawn: (pid) => {
      spawned.push(pid);
    },
  });

  const [group] = spawned;

  invariant(group !== undefined);

  expect(run).toStrictEqual({ exitCode: -1, stdout: '', stderr: '', timedOut: true });

  // The gh leads its own process group. A killed group lingers until it is
  // reaped, and one that escaped the kill hangs far longer than this wait.
  await waitFor(() => {
    expect(() => process.kill(-group, 0)).toThrow('ESRCH');
  });
});

test('it stops every process a gh that is still running at abort started', async () => {
  const ctx = setupTest();
  const pidsFile = join(ctx.dir, 'pids');
  const gh = createStubBin(ctx.dir, 'gh', buildStubForkingGH(pidsFile));

  const controller = new AbortController();

  const running = runGH(gh, controller.signal, ['repo', 'list']);

  registerTestCleanup(async () => {
    controller.abort();

    await running;
  });

  const pids = await waitFor(() => readFile(pidsFile, 'utf8'));

  const [group, child] = pids.trim().split('\n');

  controller.abort();

  const run = await running;

  expect(run).toStrictEqual({ exitCode: -1, stdout: '', stderr: '', timedOut: true });

  // The killed group's processes linger until the kernel reaps them, and a
  // child that escaped the kill would outlive this wait by far.
  await waitFor(
    () => {
      expect(() => process.kill(-Number(group), 0)).toThrow('ESRCH');
      expect(() => process.kill(Number(child), 0)).toThrow('ESRCH');
    },
    { timeoutMs: 3000 },
  );
});
