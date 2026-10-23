import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubNpm } from './build-stub-npm';
import { createStubBin } from './create-stub-bin';
import { runCommand } from './run-command';
import { setupTempDir } from './setup-temp-dir';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-stub-npm-');

  return { directory: temporaryDirectory.path };
}

test('it fails a view of a version the registry lacks with an E404 and exit code 1', async () => {
  const ctx = setupTest();

  const npm = createStubBin(
    ctx.directory,
    'npm',
    buildStubNpm(join(ctx.directory, 'npm.log'), null),
  );

  const viewed = await runCommand([npm, 'view', '@atcx/contract@7.1.0', 'version']);

  expect({
    exitCode: viewed.exitCode,
    stdout: viewed.stdout,
    stderr: viewed.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'npm error code E404\nnpm error 404 No match found for version 7.1.0\n',
  });
});

test('it answers a view of a version the registry holds with that version', async () => {
  const ctx = setupTest();

  const npm = createStubBin(
    ctx.directory,
    'npm',
    buildStubNpm(join(ctx.directory, 'npm.log'), '7.1.0'),
  );

  const viewed = await runCommand([npm, 'view', '@atcx/contract@7.1.0', 'version']);

  expect({
    exitCode: viewed.exitCode,
    stdout: viewed.stdout,
    stderr: viewed.stderr,
  }).toStrictEqual({ exitCode: 0, stdout: '7.1.0\n', stderr: '' });
});

test('it succeeds at any other command with no output', async () => {
  const ctx = setupTest();

  const npm = createStubBin(
    ctx.directory,
    'npm',
    buildStubNpm(join(ctx.directory, 'npm.log'), null),
  );

  const published = await runCommand([npm, 'publish', 'contract.tgz', '--access', 'public']);

  expect({
    exitCode: published.exitCode,
    stdout: published.stdout,
    stderr: published.stderr,
  }).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });
});

test('it records the arguments of each call in order', async () => {
  const ctx = setupTest();

  const npm = createStubBin(
    ctx.directory,
    'npm',
    buildStubNpm(join(ctx.directory, 'npm.log'), null),
  );

  await runCommand([npm, 'view', '@atcx/contract@7.1.0', 'version']);
  await runCommand([npm, 'publish', 'contract.tgz', '--provenance']);

  expect(readFileSync(join(ctx.directory, 'npm.log'), 'utf8')).toBe(
    'view @atcx/contract@7.1.0 version\npublish contract.tgz --provenance\n',
  );
});
