import { expect, test } from 'bun:test';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

test.if(process.platform === 'linux')(
  'it stops with a clear message when GNU stat is not on the PATH',
  () => {
    const root = process.env['ATC_TEST_HOME'];

    if (root === undefined) {
      throw new Error('the test home fixture is not in place');
    }

    const bin = join(root, 'bin-without-stat');

    mkdirSync(bin);

    for (const tool of ['uname', 'grep', 'touch', 'sha256sum', 'dirname']) {
      const path = Bun.which(tool);

      if (path === null) {
        throw new Error(`${tool} is missing from this host`);
      }

      symlinkSync(path, join(bin, tool));
    }

    const bash = Bun.which('bash');

    if (bash === null) {
      throw new Error('bash is missing from this host');
    }

    const run = Bun.spawnSync([bash, 'scripts/check-test-isolation.sh', 'true'], {
      cwd: join(import.meta.dir, '..'),
      env: { ...process.env, PATH: bin },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(run.exitCode).toBe(2);
    expect(run.stderr.toString()).toInclude('needs GNU coreutils: stat');
  },
);

// The platform check runs before any tool check, so this run needs only the
// host's own bash and uname, never a GNU tool.
test.if(process.platform !== 'linux')(
  'it stops with a clear message on a platform other than Linux',
  () => {
    const bash = Bun.which('bash');

    if (bash === null) {
      throw new Error('bash is missing from this host');
    }

    const run = Bun.spawnSync([bash, 'scripts/check-test-isolation.sh', 'true'], {
      cwd: join(import.meta.dir, '..'),
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(run.exitCode).toBe(2);
    expect(run.stderr.toString()).toInclude('runs on Linux only');
  },
);
