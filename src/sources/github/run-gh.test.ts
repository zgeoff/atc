import { expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setupTempDir } from '../../../test/setup-temp-dir';
import { waitFor } from '../../../test/wait-for';
import { runGH } from './run-gh';

test('it stops every process a gh that outlives its time limit started', async () => {
  await using temp = setupTempDir('atc-run-gh-');

  const marker = `gh-child-${crypto.randomUUID()}`;

  // A wrapper that starts a child of its own and waits on it, as a gh
  // extension might.
  await writeFile(join(temp.dir, 'gh'), `#!/bin/sh\nsh -c 'sleep 30; echo ${marker}' &\nwait\n`, {
    mode: 0o755,
  });

  const run = await runGH(join(temp.dir, 'gh'), 300, ['repo', 'list']);

  expect(run).toStrictEqual({ exitCode: -1, stdout: '', stderr: '', timedOut: true });

  // The killed group's processes linger until the kernel reaps them, and a
  // child that escaped the kill would outlive this wait by far.
  await waitFor(
    () => {
      expect(Bun.spawnSync(['pgrep', '-f', marker]).stdout.toString()).toBe('');
    },
    { timeoutMs: 3000 },
  );
});
