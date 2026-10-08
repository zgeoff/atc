import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand } from '../src/test-utils/run-command';
import { setupTempDir } from '../src/test-utils/setup-temp-dir';

// A temp directory that holds the host config a test hands the script, and
// the directory outside any repository that the script's command runs in.
function setupTest() {
  const tmp = setupTempDir('atc-with-test-home-');

  return { dir: tmp.dir };
}

test('it keeps a host XDG git config away from a command it runs', async () => {
  const ctx = setupTest();
  const host = join(ctx.dir, 'host-xdg');

  mkdirSync(join(host, 'git'), { recursive: true });
  writeFileSync(join(host, 'git', 'config'), '[atc]\n\tcanary = host\n');

  const read = await runCommand(
    ['bash', join(import.meta.dir, 'with-test-home.sh'), 'git', 'config', '--get', 'atc.canary'],
    {
      cwd: ctx.dir,
      env: { ...process.env, XDG_CONFIG_HOME: host },
    },
  );

  expect({ exitCode: read.exitCode, stdout: read.stdout }).toStrictEqual({
    exitCode: 1,
    stdout: '',
  });
});
