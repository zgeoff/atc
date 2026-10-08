import { expect, test } from 'bun:test';
import { mkdirSync, symlinkSync } from 'node:fs';
import { type } from 'node:os';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { runCommand } from '../src/test-utils/run-command';
import { setupTempDir } from '../src/test-utils/setup-temp-dir';

/**
 * A temp directory for the stand-in tool directory a test builds.
 */
function setupTest() {
  const tmp = setupTempDir('atc-isolation-bin-');

  return { dir: tmp.dir };
}

test.if(process.platform === 'linux')(
  'it stops with a clear message when GNU stat is not on the PATH',
  async () => {
    const ctx = setupTest();
    const bin = join(ctx.dir, 'bin');

    mkdirSync(bin);

    for (const tool of ['uname', 'grep', 'touch', 'sha256sum', 'dirname']) {
      const path = Bun.which(tool);

      invariant(path !== null, `${tool} is missing from this host`);
      symlinkSync(path, join(bin, tool));
    }

    const bash = Bun.which('bash');

    invariant(bash !== null, 'bash is missing from this host');

    const run = await runCommand([bash, 'scripts/check-test-isolation.sh', 'true'], {
      cwd: join(import.meta.dir, '..'),
      env: { ...process.env, PATH: bin },
    });

    expect({ exitCode: run.exitCode, stderr: run.stderr }).toStrictEqual({
      exitCode: 2,
      stderr: 'test isolation: needs GNU coreutils: stat is missing or not the GNU build\n',
    });
  },
);

// The platform check runs before any tool check, so this run needs only the
// host's own bash and uname, never a GNU tool.
test.if(process.platform !== 'linux')(
  'it stops with a clear message on a platform other than Linux',
  async () => {
    const bash = Bun.which('bash');

    invariant(bash !== null, 'bash is missing from this host');

    const run = await runCommand([bash, 'scripts/check-test-isolation.sh', 'true'], {
      cwd: join(import.meta.dir, '..'),
    });

    expect({ exitCode: run.exitCode, stderr: run.stderr }).toStrictEqual({
      exitCode: 2,
      stderr: `test isolation: runs on Linux only, not ${type()}\n`,
    });
  },
);
