import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubNpm, createStubBin, runCommand, setupTempDir } from '@atc/test-utils';

function setupTest() {
  const temporaryDirectory = setupTempDir('publish-tarball-');

  return { directory: temporaryDirectory.path };
}

test.each([
  ['no tarball', []],
  ['a second positional', ['contract.tgz', 'extra.tgz']],
  ['an option', ['--tag', 'next', 'contract.tgz']],
])('it refuses %s before it reads a tarball or calls npm', async (_label, args) => {
  const ctx = setupTest();

  createStubBin(
    join(ctx.directory, 'bin'),
    'npm',
    buildStubNpm(join(ctx.directory, 'npm.log'), null),
  );

  const published = await runCommand(
    ['bash', join(import.meta.dir, 'publish-tarball.sh'), ...args],
    {
      cwd: ctx.directory,
      env: { ...process.env, PATH: `${join(ctx.directory, 'bin')}:${process.env['PATH']}` },
    },
  );

  expect(published.exitCode).toBe(2);
  expect(published.stderr).toInclude('usage: publish-tarball.sh <tarball>');
  expect(existsSync(join(ctx.directory, 'npm.log'))).toBeFalse();
});

test('it publishes a version npm does not hold with provenance', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.directory, 'package/package.json'),
    JSON.stringify({ name: '@atcx/contract', version: '7.1.0' }),
  );

  await runCommand(['tar', '-czf', 'contract.tgz', 'package'], { cwd: ctx.directory });

  createStubBin(
    join(ctx.directory, 'bin'),
    'npm',
    buildStubNpm(join(ctx.directory, 'npm.log'), null),
  );

  const published = await runCommand(
    ['bash', join(import.meta.dir, 'publish-tarball.sh'), join(ctx.directory, 'contract.tgz')],
    { env: { ...process.env, PATH: `${join(ctx.directory, 'bin')}:${process.env['PATH']}` } },
  );

  expect(published.exitCode).toBe(0);

  expect(readFileSync(join(ctx.directory, 'npm.log'), 'utf8')).toBe(
    `view @atcx/contract@7.1.0 version\npublish ${join(ctx.directory, 'contract.tgz')} --access public --provenance\n`,
  );
});

test('it publishes nothing when npm holds the version already', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.directory, 'package/package.json'),
    JSON.stringify({ name: '@atcx/contract', version: '7.1.0' }),
  );

  await runCommand(['tar', '-czf', 'contract.tgz', 'package'], { cwd: ctx.directory });

  createStubBin(
    join(ctx.directory, 'bin'),
    'npm',
    buildStubNpm(join(ctx.directory, 'npm.log'), '7.1.0'),
  );

  const published = await runCommand(
    ['bash', join(import.meta.dir, 'publish-tarball.sh'), join(ctx.directory, 'contract.tgz')],
    { env: { ...process.env, PATH: `${join(ctx.directory, 'bin')}:${process.env['PATH']}` } },
  );

  expect({ exitCode: published.exitCode, stdout: published.stdout }).toStrictEqual({
    exitCode: 0,
    stdout: '@atcx/contract@7.1.0 is on npm already\n',
  });

  expect(readFileSync(join(ctx.directory, 'npm.log'), 'utf8')).toBe(
    'view @atcx/contract@7.1.0 version\n',
  );
});
