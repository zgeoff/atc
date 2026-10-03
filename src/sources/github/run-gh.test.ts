import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { setupTempDir } from '../../../test/setup-temp-dir';
import { runGH } from './run-gh';

test('it stops every process a gh that outlives its time limit started', async () => {
  await using temp = setupTempDir('atc-run-gh-');

  const marker = `gh-child-${crypto.randomUUID()}`;
  const gh = join(temp.dir, 'gh');

  // A wrapper that starts a child of its own and waits on it, as a gh
  // extension might.
  await Bun.write(gh, `#!/bin/sh\nsh -c 'sleep 30; echo ${marker}' &\nwait\n`);
  await Bun.$`chmod 755 ${gh}`.quiet();

  const run = await runGH(gh, 300, ['repo', 'list']);

  // A killed process group is gone once the kernel reaps it, which takes a
  // moment after the signal.
  await Bun.sleep(300);

  const left = Bun.spawnSync(['pgrep', '-f', marker]).stdout.toString();

  expect(run).toStrictEqual({ exitCode: -1, stdout: '', stderr: '', timedOut: true });
  expect(left).toBe('');
});
