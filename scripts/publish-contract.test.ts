import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubNpm } from '@atc/core/test-utils/build-stub-npm';
import { createStubBin } from '@zgeoff/testing/bin';
import { createTempDir } from '@zgeoff/testing/fs';
import { run } from '@zgeoff/testing/process';

// The entry script takes the root from its own path. The packer is a stand-in that prints the
// tarball of the package it is asked for.
function setupTest() {
  const temporaryDirectory = createTempDir('publish-contract-');

  mkdirSync(join(temporaryDirectory.path, 'scripts'));

  for (const script of ['publish-contract.sh', 'publish-tarball.sh', 'check-tarball-imports.mjs']) {
    symlinkSync(join(import.meta.dir, script), join(temporaryDirectory.path, 'scripts', script));
  }

  const directory = temporaryDirectory.path;

  return {
    directory,
    env: { ...process.env, PATH: `${join(directory, 'bin')}:${process.env['PATH']}` },
    packerScript: `const name = process.argv[process.argv.indexOf('--package') + 1];
console.log(${JSON.stringify(directory)} + '/tarball/' + name + '/' + name + '.tgz');
`,
  };
}

test.each([
  ['an option it does not know', ['--tag', 'next']],
  ['help', ['--help']],
  ['a positional', ['--dry-run', 'extra']],
])('it refuses %s before it packs or publishes', async (_label, args) => {
  const ctx = setupTest();

  createStubBin(join(ctx.directory, 'bin'), 'npm', {
    script: buildStubNpm(join(ctx.directory, 'npm.log'), null),
  });

  const published = await run(
    ['bash', join(ctx.directory, 'scripts/publish-contract.sh'), ...args],
    { env: ctx.env },
  );

  expect(published.exitCode).toBe(2);
  expect(published.stderr).toInclude('usage: publish-contract.sh [--dry-run]');
  expect(existsSync(join(ctx.directory, 'npm.log'))).toBeFalse();
});

test.each(['catalog:', 'workspace:*'])(
  'it refuses a packed manifest that names a %s version before npm runs',
  async (version) => {
    const ctx = setupTest();

    await Bun.write(
      join(ctx.directory, 'tarball/contract/package/package.json'),
      JSON.stringify({ name: '@atcx/contract', version: '7.3.0', dependencies: { zod: version } }),
    );

    await run(['tar', '-czf', 'contract.tgz', 'package'], {
      cwd: join(ctx.directory, 'tarball/contract'),
    });

    await Bun.write(join(ctx.directory, 'scripts/pack-contract.ts'), ctx.packerScript);

    createStubBin(join(ctx.directory, 'bin'), 'npm', {
      script: buildStubNpm(join(ctx.directory, 'npm.log'), null),
    });

    const published = await run(['bash', join(ctx.directory, 'scripts/publish-contract.sh')], {
      env: ctx.env,
    });

    expect({ exitCode: published.exitCode, stdout: published.stdout }).toStrictEqual({
      exitCode: 1,
      stdout: '::error::the packed @atcx/contract still names a catalog: or workspace: version\n',
    });

    expect(existsSync(join(ctx.directory, 'npm.log'))).toBeFalse();
  },
);

test('it refuses a packed archive that holds TypeScript source before npm runs', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.directory, 'tarball/contract/package/package.json'),
    JSON.stringify({ name: '@atcx/contract', version: '7.3.0', files: ['dist'] }),
  );

  await Bun.write(join(ctx.directory, 'tarball/contract/package/dist/index.d.ts'), 'export {};\n');
  await Bun.write(join(ctx.directory, 'tarball/contract/package/dist/index.ts'), 'export {};\n');

  await run(['tar', '-czf', 'contract.tgz', 'package'], {
    cwd: join(ctx.directory, 'tarball/contract'),
  });

  await Bun.write(join(ctx.directory, 'scripts/pack-contract.ts'), ctx.packerScript);

  createStubBin(join(ctx.directory, 'bin'), 'npm', {
    script: buildStubNpm(join(ctx.directory, 'npm.log'), null),
  });

  const published = await run(['bash', join(ctx.directory, 'scripts/publish-contract.sh')], {
    env: ctx.env,
  });

  expect({ exitCode: published.exitCode, stdout: published.stdout }).toStrictEqual({
    exitCode: 1,
    stdout:
      'package/dist/index.ts\n::error::the packed @atcx/contract holds the TypeScript source above\n',
  });

  expect(existsSync(join(ctx.directory, 'npm.log'))).toBeFalse();
});

test.each([
  ['a module that is no dependency', "import { left } from 'left-pad';\n", 'imports left-pad'],
  ['the Bun global', 'export const text = Bun.file("x").text();\n', 'uses the Bun global'],
])('it refuses a packed package that holds %s before npm runs', async (_label, source, failure) => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.directory, 'tarball/contract/package/package.json'),
    JSON.stringify({ name: '@atcx/contract', version: '7.3.0', dependencies: { zod: '4.6.7' } }),
  );

  await Bun.write(join(ctx.directory, 'tarball/contract/package/dist/index.js'), source);

  await run(['tar', '-czf', 'contract.tgz', 'package'], {
    cwd: join(ctx.directory, 'tarball/contract'),
  });

  await Bun.write(join(ctx.directory, 'scripts/pack-contract.ts'), ctx.packerScript);

  createStubBin(join(ctx.directory, 'bin'), 'npm', {
    script: buildStubNpm(join(ctx.directory, 'npm.log'), null),
  });

  const published = await run(['bash', join(ctx.directory, 'scripts/publish-contract.sh')], {
    env: ctx.env,
  });

  expect({
    exitCode: published.exitCode,
    output: `${published.stdout}${published.stderr}`,
  }).toStrictEqual({ exitCode: 1, output: expect.stringContaining(failure) });

  expect(existsSync(join(ctx.directory, 'npm.log'))).toBeFalse();
});

test('it publishes the contract and then the client with provenance when npm lacks their versions', async () => {
  const ctx = setupTest();

  for (const name of ['contract', 'client']) {
    await Bun.write(
      join(ctx.directory, `tarball/${name}/package/package.json`),
      JSON.stringify({
        name: `@atcx/${name}`,
        version: '7.3.0',
        files: ['dist'],
        dependencies: { zod: '4.6.7' },
      }),
    );

    await Bun.write(
      join(ctx.directory, `tarball/${name}/package/dist/index.js`),
      "import { z } from 'zod';\nexport { z };\n",
    );

    await run(['tar', '-czf', `${name}.tgz`, 'package'], {
      cwd: join(ctx.directory, `tarball/${name}`),
    });
  }

  await Bun.write(join(ctx.directory, 'scripts/pack-contract.ts'), ctx.packerScript);

  createStubBin(join(ctx.directory, 'bin'), 'npm', {
    script: buildStubNpm(join(ctx.directory, 'npm.log'), null),
  });

  const published = await run(['bash', join(ctx.directory, 'scripts/publish-contract.sh')], {
    env: ctx.env,
  });

  expect(published.exitCode).toBe(0);

  expect(readFileSync(join(ctx.directory, 'npm.log'), 'utf8').split('\n')).toStrictEqual([
    'view @atcx/contract@7.3.0 version',
    `publish ${join(ctx.directory, 'tarball/contract/contract.tgz')} --access public --provenance`,
    'view @atcx/client@7.3.0 version',
    `publish ${join(ctx.directory, 'tarball/client/client.tgz')} --access public --provenance`,
    '',
  ]);
});

test('it publishes nothing when npm holds the packed versions already', async () => {
  const ctx = setupTest();

  for (const name of ['contract', 'client']) {
    await Bun.write(
      join(ctx.directory, `tarball/${name}/package/package.json`),
      JSON.stringify({ name: `@atcx/${name}`, version: '7.3.0', files: ['dist'] }),
    );

    await Bun.write(join(ctx.directory, `tarball/${name}/package/dist/index.js`), 'export {};\n');

    await run(['tar', '-czf', `${name}.tgz`, 'package'], {
      cwd: join(ctx.directory, `tarball/${name}`),
    });
  }

  await Bun.write(join(ctx.directory, 'scripts/pack-contract.ts'), ctx.packerScript);

  createStubBin(join(ctx.directory, 'bin'), 'npm', {
    script: buildStubNpm(join(ctx.directory, 'npm.log'), '7.3.0'),
  });

  const published = await run(['bash', join(ctx.directory, 'scripts/publish-contract.sh')], {
    env: ctx.env,
  });

  expect({ exitCode: published.exitCode, stdout: published.stdout }).toStrictEqual({
    exitCode: 0,
    stdout:
      '@atcx/contract imports only its dependencies and node: modules\n@atcx/client imports only its dependencies and node: modules\n@atcx/contract@7.3.0 is on npm already\n@atcx/client@7.3.0 is on npm already\n',
  });

  expect(readFileSync(join(ctx.directory, 'npm.log'), 'utf8')).toBe(
    'view @atcx/contract@7.3.0 version\nview @atcx/client@7.3.0 version\n',
  );
});
