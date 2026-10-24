import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubNpm, createStubBin, runCommand, setupTempDir } from '@atc/test-utils';

function setupTest() {
  const temporaryDirectory = setupTempDir('publish-tarball-');

  return { directory: temporaryDirectory.path };
}

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
