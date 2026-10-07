import { expect, onTestFinished, test } from 'bun:test';
import { getEventListeners } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildStubForkingGH } from '../../test-utils/build-stub-forking-gh';
import { buildStubGH } from '../../test-utils/build-stub-gh';
import { createStubBin } from '../../test-utils/create-stub-bin';
import { setupTempDir } from '../../test-utils/setup-temp-dir';
import { waitFor } from '../../test-utils/wait-for';
import { runGH } from './run-gh';

// A directory for a stand-in gh and the files it records.
function setupTest() {
  return setupTempDir('atc-run-gh-');
}

test('it returns what gh printed and its exit code, and stops listening for an abort', async () => {
  using ctx = setupTest();

  const argvFile = join(ctx.dir, 'argv');

  const gh = createStubBin(
    ctx.dir,
    'gh',
    buildStubGH({ replies: { repo: { stdout: 'out\n', stderr: 'err\n', exitCode: 3 } }, argvFile }),
  );

  const controller = new AbortController();

  const run = await runGH(gh, controller.signal, ['repo', 'list']);

  expect({
    run,
    argv: await readFile(argvFile, 'utf8'),
    listeners: getEventListeners(controller.signal, 'abort'),
  }).toStrictEqual({
    run: { exitCode: 3, stdout: 'out\n', stderr: 'err\n', timedOut: false },
    argv: 'repo list\n',
    listeners: [],
  });
});

test('it stops a gh at once when the signal aborted before the call', async () => {
  using ctx = setupTest();

  const gh = createStubBin(ctx.dir, 'gh', buildStubGH({ replies: { repo: 'hang' } }));

  const run = await runGH(gh, AbortSignal.abort(), ['repo', 'list']);

  expect(run).toStrictEqual({ exitCode: -1, stdout: '', stderr: '', timedOut: true });
});

test('it stops every process a gh that is still running at abort started', async () => {
  using ctx = setupTest();

  const pidsFile = join(ctx.dir, 'pids');
  const gh = createStubBin(ctx.dir, 'gh', buildStubForkingGH(pidsFile));

  const controller = new AbortController();

  const running = runGH(gh, controller.signal, ['repo', 'list']);

  onTestFinished(async () => {
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
