import { expect, test } from 'bun:test';
import { getEventListeners } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setupTempDir } from '../../test-utils/setup-temp-dir';
import { waitFor } from '../../test-utils/wait-for';
import { runGH } from './run-gh';

// A directory for a fake gh script and the process IDs it records.
function setupTest() {
  const temp = setupTempDir('atc-run-gh-');

  return {
    gh: join(temp.dir, 'gh'),
    pids: join(temp.dir, 'pids'),
    [Symbol.asyncDispose]: temp[Symbol.asyncDispose],
  };
}

test('it returns what gh printed and its exit code, and stops listening for an abort', async () => {
  await using ctx = setupTest();

  await writeFile(ctx.gh, '#!/bin/sh\necho "out $*"\necho err >&2\nexit 3\n', { mode: 0o755 });

  const controller = new AbortController();

  const run = await runGH(ctx.gh, controller.signal, ['repo', 'list']);

  expect({ run, listeners: getEventListeners(controller.signal, 'abort') }).toStrictEqual({
    run: { exitCode: 3, stdout: 'out repo list\n', stderr: 'err\n', timedOut: false },
    listeners: [],
  });
});

test('it stops a gh at once when the signal aborted before the call', async () => {
  await using ctx = setupTest();

  await writeFile(ctx.gh, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });

  const run = await runGH(ctx.gh, AbortSignal.abort(), ['repo', 'list']);

  expect(run).toStrictEqual({ exitCode: -1, stdout: '', stderr: '', timedOut: true });
});

test('it stops every process a gh that is still running at abort started', async () => {
  await using ctx = setupTest();

  // A wrapper that starts a child of its own and waits on it, as a gh
  // extension might. It records its own ID, which is also the ID of the
  // process group it leads, and its child's ID, moving the file into place
  // so it appears whole.
  await writeFile(
    ctx.gh,
    `#!/bin/sh\nsh -c 'sleep 30' &\nprintf '%s\\n%s\\n' $$ $! > '${ctx.pids}.tmp'\nmv '${ctx.pids}.tmp' '${ctx.pids}'\nwait\n`,
    { mode: 0o755 },
  );

  const controller = new AbortController();

  const running = runGH(ctx.gh, controller.signal, ['repo', 'list']);

  const pids = await waitFor(() => readFile(ctx.pids, 'utf8'));

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
