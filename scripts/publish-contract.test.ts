import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubNpm, createStubBin, runCommand, setupTempDir } from '@atc/test-utils';

// A temp repo root that holds the real release scripts, so the entry script
// takes the root from its own path and runs the packer that the test writes.
function setupTest() {
  const temporaryDirectory = setupTempDir('publish-contract-');

  mkdirSync(join(temporaryDirectory.path, 'scripts'));

  for (const script of ['publish-contract.sh', 'publish-tarball.sh']) {
    symlinkSync(join(import.meta.dir, script), join(temporaryDirectory.path, 'scripts', script));
  }

  return { directory: temporaryDirectory.path };
}

test.each([
  ['an option it does not know', ['--tag', 'next']],
  ['help', ['--help']],
  ['a positional', ['--dry-run', 'extra']],
])('it refuses %s before it packs or publishes', async (_label, args) => {
  const ctx = setupTest();

  createStubBin(
    join(ctx.directory, 'bin'),
    'npm',
    buildStubNpm(join(ctx.directory, 'npm.log'), null),
  );

  const published = await runCommand(
    ['bash', join(ctx.directory, 'scripts/publish-contract.sh'), ...args],
    { env: { ...process.env, PATH: `${join(ctx.directory, 'bin')}:${process.env['PATH']}` } },
  );

  expect(published.exitCode).toBe(2);
  expect(published.stderr).toInclude('usage: publish-contract.sh [--dry-run]');
  expect(existsSync(join(ctx.directory, 'npm.log'))).toBeFalse();
});

test('it publishes the packed contract with provenance when npm lacks its version', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.directory, 'tarball/package/package.json'),
    JSON.stringify({ name: '@atcx/contract', version: '7.3.0', files: ['dist'] }),
  );

  await Bun.write(join(ctx.directory, 'tarball/package/dist/index.js'), 'export {};\n');

  await runCommand(['tar', '-czf', 'contract.tgz', 'package'], {
    cwd: join(ctx.directory, 'tarball'),
  });

  await Bun.write(
    join(ctx.directory, 'scripts/pack-contract.ts'),
    `console.log(${JSON.stringify(join(ctx.directory, 'tarball/contract.tgz'))});\n`,
  );

  createStubBin(
    join(ctx.directory, 'bin'),
    'npm',
    buildStubNpm(join(ctx.directory, 'npm.log'), null),
  );

  const published = await runCommand(['bash', join(ctx.directory, 'scripts/publish-contract.sh')], {
    env: { ...process.env, PATH: `${join(ctx.directory, 'bin')}:${process.env['PATH']}` },
  });

  expect(published.exitCode).toBe(0);

  expect(readFileSync(join(ctx.directory, 'npm.log'), 'utf8')).toBe(
    `view @atcx/contract@7.3.0 version\npublish ${join(ctx.directory, 'tarball/contract.tgz')} --access public --provenance\n`,
  );
});

test('it publishes nothing when npm holds the packed version already', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.directory, 'tarball/package/package.json'),
    JSON.stringify({ name: '@atcx/contract', version: '7.3.0', files: ['dist'] }),
  );

  await Bun.write(join(ctx.directory, 'tarball/package/dist/index.js'), 'export {};\n');

  await runCommand(['tar', '-czf', 'contract.tgz', 'package'], {
    cwd: join(ctx.directory, 'tarball'),
  });

  await Bun.write(
    join(ctx.directory, 'scripts/pack-contract.ts'),
    `console.log(${JSON.stringify(join(ctx.directory, 'tarball/contract.tgz'))});\n`,
  );

  createStubBin(
    join(ctx.directory, 'bin'),
    'npm',
    buildStubNpm(join(ctx.directory, 'npm.log'), '7.3.0'),
  );

  const published = await runCommand(['bash', join(ctx.directory, 'scripts/publish-contract.sh')], {
    env: { ...process.env, PATH: `${join(ctx.directory, 'bin')}:${process.env['PATH']}` },
  });

  expect({ exitCode: published.exitCode, stdout: published.stdout }).toStrictEqual({
    exitCode: 0,
    stdout: '@atcx/contract@7.3.0 is on npm already\n',
  });

  expect(readFileSync(join(ctx.directory, 'npm.log'), 'utf8')).toBe(
    'view @atcx/contract@7.3.0 version\n',
  );
});
