import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../src/test-utils/setup-temp-dir';

// A temp directory that holds the host config a test hands the script.
function setupTest() {
  return setupTempDir('atc-with-test-home-');
}

test('it keeps a host XDG git config away from a command it runs', () => {
  using ctx = setupTest();

  const host = join(ctx.dir, 'host-xdg');

  mkdirSync(join(host, 'git'), { recursive: true });
  writeFileSync(join(host, 'git', 'config'), '[atc]\n\tcanary = host\n');

  const read = Bun.spawnSync(
    ['bash', join(import.meta.dir, 'with-test-home.sh'), 'git', 'config', '--get', 'atc.canary'],
    {
      cwd: join(import.meta.dir, '..'),
      env: { ...process.env, XDG_CONFIG_HOME: host },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );

  expect({ exitCode: read.exitCode, stdout: read.stdout.toString() }).toStrictEqual({
    exitCode: 1,
    stdout: '',
  });
});
