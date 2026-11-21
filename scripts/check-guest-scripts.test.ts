import { expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createStubBin } from '@zgeoff/testing/bin';
import { createTempDir } from '@zgeoff/testing/fs';
import { run } from '@zgeoff/testing/process';

function setupTest() {
  const temporaryDirectory = createTempDir('check-guest-scripts-');
  const bin = join(temporaryDirectory.path, 'bin');
  const root = join(temporaryDirectory.path, 'root');

  mkdirSync(bin);
  mkdirSync(root);

  return { bin, root };
}

test('it passes when shellcheck reports no finding', async () => {
  const ctx = setupTest();

  createStubBin(ctx.bin, 'shellcheck', { script: '#!/bin/sh\nexit 0\n' });

  const checked = await run([process.execPath, join(import.meta.dir, 'check-guest-scripts.ts')], {
    env: { ...process.env, PATH: ctx.bin },
  });

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 0,
    stdout: expect.toEndWith(' scripts, 0 findings, 0 unchecked\n'),
    stderr: '',
  });
});

test('it fails on a shellcheck finding and names the script it is in', async () => {
  const ctx = setupTest();

  createStubBin(ctx.bin, 'shellcheck', {
    script: `#!/bin/sh\necho 'GUEST_CLONE_SCRIPT.sh:1:4: note: Double quote to prevent globbing and word splitting. [SC2086]'\nexit 1\n`,
  });

  const checked = await run([process.execPath, join(import.meta.dir, 'check-guest-scripts.ts')], {
    env: { ...process.env, PATH: ctx.bin },
  });

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: expect.toEndWith(' scripts, 1 findings, 0 unchecked\n'),
    stderr:
      'GUEST_CLONE_SCRIPT.sh:1:4: note: Double quote to prevent globbing and word splitting. [SC2086]\n',
  });
});

test('it fails on an exported script constant that it does not check', async () => {
  const ctx = setupTest();

  createStubBin(ctx.bin, 'shellcheck', { script: '#!/bin/sh\nexit 0\n' });

  await Bun.write(
    join(ctx.root, 'packages/box/src/run-box.ts'),
    'export const START_BOX_SCRIPT = \'exec "$@"\';\n',
  );

  const checked = await run(
    [process.execPath, join(import.meta.dir, 'check-guest-scripts.ts'), ctx.root],
    { env: { ...process.env, PATH: ctx.bin } },
  );

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: expect.toEndWith(' scripts, 0 findings, 1 unchecked\n'),
    stderr:
      "unchecked script: packages/box/src/run-box.ts exports START_BOX_SCRIPT; re-export it from its package's guest-scripts entry\n",
  });
});

test('it fails when shellcheck is not on the PATH', async () => {
  const ctx = setupTest();

  const checked = await run([process.execPath, join(import.meta.dir, 'check-guest-scripts.ts')], {
    env: { ...process.env, PATH: ctx.bin },
  });

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'shellcheck is not on the PATH; install it to run this check\n',
  });
});
