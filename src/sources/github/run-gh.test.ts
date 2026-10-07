import { expect, test } from 'bun:test';
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

test('it stops every process a gh that outlives its time limit started', async () => {
  await using ctx = setupTest();

  // A wrapper that starts a child of its own and waits on it, as a gh
  // extension might. It records its own ID, which is also the ID of the
  // process group it leads, and its child's ID.
  await writeFile(
    ctx.gh,
    `#!/bin/sh\necho $$ > '${ctx.pids}'\nsh -c 'sleep 30' &\necho $! >> '${ctx.pids}'\nwait\n`,
    { mode: 0o755 },
  );

  const run = await runGH(ctx.gh, 300, ['repo', 'list']);
  const pids = await readFile(ctx.pids, 'utf8');

  const [group, child] = pids.trim().split('\n');

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
