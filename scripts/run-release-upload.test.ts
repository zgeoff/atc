import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStubBin, runCommand, setupTempDir } from '@atc/test-utils';
import { runReleaseUpload } from './run-release-upload';

// A release checkout and a stub gh that records its arguments, one per line.
function setupTest() {
  const temporaryDirectory = setupTempDir('run-release-upload-');
  const root = join(temporaryDirectory.path, 'release');
  const bin = join(temporaryDirectory.path, 'bin');
  const calls = join(temporaryDirectory.path, 'gh-calls');

  createStubBin(bin, 'gh', `#!/bin/sh\nprintf '%s\\n' "$@" >> '${calls}'\n`);

  return { root, bin, calls };
}

test('it uploads every binary and the checksums to the release of the checkout version', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.root, 'dist'), { recursive: true });
  writeFileSync(join(ctx.root, 'package.json'), JSON.stringify({ version: '4.2.0' }));
  writeFileSync(join(ctx.root, 'dist', 'atc-linux-x64'), 'binary');
  writeFileSync(join(ctx.root, 'dist', 'atc-darwin-arm64'), 'binary');
  writeFileSync(join(ctx.root, 'dist', 'SHA256SUMS'), 'sums');

  await runReleaseUpload({
    root: ctx.root,
    repository: 'example/tower',
    env: { ...process.env, PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect(readFileSync(ctx.calls, 'utf8').split('\n')).toStrictEqual([
    'release',
    'upload',
    '@zgeoff/atc@4.2.0',
    'dist/atc-darwin-arm64',
    'dist/atc-linux-x64',
    'dist/SHA256SUMS',
    '--clobber',
    '--repo',
    'example/tower',
    '',
  ]);
});

test('it refuses a checkout whose dist holds no binary', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.root, 'dist'), { recursive: true });
  writeFileSync(join(ctx.root, 'package.json'), JSON.stringify({ version: '4.2.0' }));

  expect(
    runReleaseUpload({
      root: ctx.root,
      repository: 'example/tower',
      env: { ...process.env, PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}` },
    }),
  ).rejects.toThrowWithMessage(Error, /no binaries match dist\/atc-\*/u);
});

test('it exits 1 and names the refusal when the checkout it runs in holds no binary', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.root, 'dist'), { recursive: true });
  writeFileSync(join(ctx.root, 'package.json'), JSON.stringify({ version: '4.2.0' }));

  const upload = await runCommand(
    [process.execPath, join(import.meta.dir, 'run-release-upload.ts')],
    {
      cwd: ctx.root,
      env: {
        ...process.env,
        GITHUB_REPOSITORY: 'example/tower',
        PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}`,
      },
    },
  );

  expect({ exitCode: upload.exitCode, stdout: upload.stdout, stderr: upload.stderr }).toStrictEqual(
    {
      exitCode: 1,
      stdout: '',
      stderr: `run-release-upload: no binaries match dist/atc-* under ${realpathSync(ctx.root)}\n`,
    },
  );
});
