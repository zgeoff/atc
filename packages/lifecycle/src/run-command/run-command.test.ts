import { expect, test } from 'bun:test';
import { getEventListeners } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildStubForkingGH,
  createStubBin,
  registerTestCleanup,
  setupTempDir,
  waitFor,
} from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { runCommand } from './run-command';

// A directory for stand-in commands and the files they write.
function setupTest() {
  const temporaryDirectory = setupTempDir('atc-run-command-');

  return { directory: temporaryDirectory.path };
}

test('it returns the exit code and the trimmed output of a command', async () => {
  const result = await runCommand(['sh', '-c', 'echo " out "; echo " err " >&2; exit 3']);

  expect(result).toStrictEqual({ code: 3, stdout: 'out', stderr: 'err', aborted: false });
});

test('it returns once a command exits when told to ignore stderr that a child keeps open', async () => {
  const ctx = setupTest();
  const pidFile = join(ctx.directory, 'child.pid');

  const result = await runCommand(
    ['sh', '-c', `sleep 30 >/dev/null & echo $! > '${pidFile}'; printf out`],
    { signal: AbortSignal.timeout(1000), stderr: 'ignore' },
  );

  // A run that aborted has already killed the child's process group.
  const pid = await readFile(pidFile, 'utf8');

  registerTestCleanup(() => {
    process.kill(Number(pid), 'SIGKILL');
  });

  expect(result).toStrictEqual({ code: 0, stdout: 'out', stderr: '', aborted: false });
});

test('it reads a command that cannot start as exit code 127', async () => {
  const result = await runCommand(['atc-no-such-command']);

  expect(result).toStrictEqual({
    code: 127,
    stdout: '',
    stderr: expect.toBeString(),
    aborted: false,
  });
});

test('it gives a command its variables over the environment it inherits', async () => {
  const result = await runCommand(['sh', '-c', 'printf "%s %s" "$ATC_RUN_TEST" "$HOME"'], {
    env: { ATC_RUN_TEST: 'set' },
  });

  expect(result.stdout).toBe(`set ${process.env['HOME'] ?? ''}`);
});

test('it reports the pid of the command it starts, and stops listening for an abort once it ends', async () => {
  const controller = new AbortController();

  const spawned: number[] = [];

  const result = await runCommand(['sh', '-c', 'echo $$'], {
    signal: controller.signal,
    onSpawn: (pid) => {
      spawned.push(pid);
    },
  });

  expect(spawned).toStrictEqual([Number(result.stdout)]);
  expect(getEventListeners(controller.signal, 'abort')).toStrictEqual([]);
});

test('it stops a command at once when the signal aborted before the call', async () => {
  const spawned: number[] = [];

  const result = await runCommand(['sleep', '30'], {
    signal: AbortSignal.abort(),
    onSpawn: (pid) => {
      spawned.push(pid);
    },
  });

  const [group] = spawned;

  invariant(group !== undefined);

  expect(result).toStrictEqual({ code: -1, stdout: '', stderr: '', aborted: true });

  // The command leads its own process group. A killed group lingers until
  // it is reaped, and one that escaped the kill hangs far longer than this
  // wait.
  await waitFor(() => {
    expect(() => process.kill(-group, 0)).toThrow('ESRCH');
  });
});

test('it stops every process a command that is still running at abort started', async () => {
  const ctx = setupTest();
  const pidsFile = join(ctx.directory, 'pids');
  const bin = createStubBin(ctx.directory, 'forking', buildStubForkingGH(pidsFile));

  const controller = new AbortController();

  const running = runCommand([bin], { signal: controller.signal });

  registerTestCleanup(async () => {
    controller.abort();

    await running;
  });

  const pids = await waitFor(() => readFile(pidsFile, 'utf8'));

  const [group, child] = pids.trim().split('\n');

  controller.abort();

  const result = await running;

  expect(result).toStrictEqual({ code: -1, stdout: '', stderr: '', aborted: true });

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
