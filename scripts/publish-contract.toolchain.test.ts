import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubNpm, createStubBin, runCommand, setupTempDir } from '@atc/test-utils';
import invariant from 'tiny-invariant';

// A temp repo root that holds the real release scripts and root manifest, so
// the entry script runs the packer that the test writes, and a stand-in npm
// that answers the registry's calls but runs each install through the real npm.
function setupTest() {
  const temporaryDirectory = setupTempDir('publish-contract-toolchain-');
  const npm = Bun.which('npm');

  invariant(npm !== null, 'the toolchain lane needs npm on PATH');
  mkdirSync(join(temporaryDirectory.path, 'scripts'));

  for (const script of ['publish-contract.sh', 'publish-tarball.sh']) {
    symlinkSync(join(import.meta.dir, script), join(temporaryDirectory.path, 'scripts', script));
  }

  symlinkSync(
    join(import.meta.dir, '..', 'package.json'),
    join(temporaryDirectory.path, 'package.json'),
  );

  return { directory: temporaryDirectory.path, npm };
}

test('it checks a tarball npm does not hold, then runs npm publish as a dry run', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.directory, 'tarball/package/package.json'),
    JSON.stringify({
      name: '@atcx/contract',
      version: '7.3.0',
      type: 'module',
      exports: { '.': './index.js', './light': './index.js' },
    }),
  );

  await Bun.write(
    join(ctx.directory, 'tarball/package/index.js'),
    `export const DAEMON_FEATURES = ['sessions'];
export const DAEMON_CONTRACT = { daemon: { hello: {} } };
export const HELLO_RESULT_SCHEMA = { parse: (value) => value };
export const SESSION_ENV_NAMES = { sessionID: 'ATC_SESSION_ID' };
export function checkDaemon() { return { verdict: 'match' }; }
export function resolveAtcPaths() { return { socketPath: '/run/atc.sock' }; }
`,
  );

  await Bun.write(
    join(ctx.directory, 'tarball/package/index.d.ts'),
    `export declare const DAEMON_FEATURES: string[];
export declare const DAEMON_CONTRACT: { daemon: { hello: object } };
export declare const HELLO_RESULT_SCHEMA: { parse(value: unknown): { daemon: string; features: string[] } };
export declare const SESSION_ENV_NAMES: { sessionID: string };
export declare function checkDaemon(hello: { daemon: string; features: string[] }): { verdict: string };
export declare function resolveAtcPaths(env: object): { socketPath: string };
export type DaemonEvent = { kind: string };
export type PublishedRecord = { id: string };
export type SessionID = string;
`,
  );

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
    buildStubNpm(join(ctx.directory, 'npm.log'), null, { installWith: ctx.npm }),
  );

  const published = await runCommand(
    ['bash', join(ctx.directory, 'scripts/publish-contract.sh'), '--dry-run'],
    { env: { ...process.env, PATH: `${join(ctx.directory, 'bin')}:${process.env['PATH']}` } },
  );

  expect(published.exitCode).toBe(0);

  expect(readFileSync(join(ctx.directory, 'npm.log'), 'utf8').split('\n')).toStrictEqual([
    expect.toStartWith('install --prefix '),
    'view @atcx/contract@7.3.0 version',
    `publish ${join(ctx.directory, 'tarball/contract.tgz')} --access public --dry-run`,
    '',
  ]);
});

test('it checks a tarball npm holds already, then skips npm publish', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.directory, 'tarball/package/package.json'),
    JSON.stringify({
      name: '@atcx/contract',
      version: '7.3.0',
      type: 'module',
      exports: { '.': './index.js', './light': './index.js' },
    }),
  );

  await Bun.write(
    join(ctx.directory, 'tarball/package/index.js'),
    `export const DAEMON_FEATURES = ['sessions'];
export const DAEMON_CONTRACT = { daemon: { hello: {} } };
export const HELLO_RESULT_SCHEMA = { parse: (value) => value };
export const SESSION_ENV_NAMES = { sessionID: 'ATC_SESSION_ID' };
export function checkDaemon() { return { verdict: 'match' }; }
export function resolveAtcPaths() { return { socketPath: '/run/atc.sock' }; }
`,
  );

  await Bun.write(
    join(ctx.directory, 'tarball/package/index.d.ts'),
    `export declare const DAEMON_FEATURES: string[];
export declare const DAEMON_CONTRACT: { daemon: { hello: object } };
export declare const HELLO_RESULT_SCHEMA: { parse(value: unknown): { daemon: string; features: string[] } };
export declare const SESSION_ENV_NAMES: { sessionID: string };
export declare function checkDaemon(hello: { daemon: string; features: string[] }): { verdict: string };
export declare function resolveAtcPaths(env: object): { socketPath: string };
export type DaemonEvent = { kind: string };
export type PublishedRecord = { id: string };
export type SessionID = string;
`,
  );

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
    buildStubNpm(join(ctx.directory, 'npm.log'), '7.3.0', { installWith: ctx.npm }),
  );

  const published = await runCommand(
    ['bash', join(ctx.directory, 'scripts/publish-contract.sh'), '--dry-run'],
    { env: { ...process.env, PATH: `${join(ctx.directory, 'bin')}:${process.env['PATH']}` } },
  );

  expect({ exitCode: published.exitCode, stdout: published.stdout }).toStrictEqual({
    exitCode: 0,
    stdout: expect.toEndWith(
      'typechecks a program that imports @atcx/contract\n@atcx/contract@7.3.0 is on npm already\n',
    ),
  });

  expect(readFileSync(join(ctx.directory, 'npm.log'), 'utf8').split('\n')).toStrictEqual([
    expect.toStartWith('install --prefix '),
    'view @atcx/contract@7.3.0 version',
    '',
  ]);
});

test.each([
  [
    'a JavaScript entry that lacks checkDaemon',
    `export const DAEMON_FEATURES = ['sessions'];
export const DAEMON_CONTRACT = { daemon: { hello: {} } };
export const HELLO_RESULT_SCHEMA = { parse: (value) => value };
export const SESSION_ENV_NAMES = { sessionID: 'ATC_SESSION_ID' };
export function resolveAtcPaths() { return { socketPath: '/run/atc.sock' }; }
`,
    `export declare const DAEMON_FEATURES: string[];
export declare const DAEMON_CONTRACT: { daemon: { hello: object } };
export declare const HELLO_RESULT_SCHEMA: { parse(value: unknown): { daemon: string; features: string[] } };
export declare const SESSION_ENV_NAMES: { sessionID: string };
export declare function checkDaemon(hello: { daemon: string; features: string[] }): { verdict: string };
export declare function resolveAtcPaths(env: object): { socketPath: string };
export type DaemonEvent = { kind: string };
export type PublishedRecord = { id: string };
export type SessionID = string;
`,
    'contract.checkDaemon is not a function',
  ],
  [
    'a declaration file that lacks SessionID',
    `export const DAEMON_FEATURES = ['sessions'];
export const DAEMON_CONTRACT = { daemon: { hello: {} } };
export const HELLO_RESULT_SCHEMA = { parse: (value) => value };
export const SESSION_ENV_NAMES = { sessionID: 'ATC_SESSION_ID' };
export function checkDaemon() { return { verdict: 'match' }; }
export function resolveAtcPaths() { return { socketPath: '/run/atc.sock' }; }
`,
    `export declare const DAEMON_FEATURES: string[];
export declare const DAEMON_CONTRACT: { daemon: { hello: object } };
export declare const HELLO_RESULT_SCHEMA: { parse(value: unknown): { daemon: string; features: string[] } };
export declare const SESSION_ENV_NAMES: { sessionID: string };
export declare function checkDaemon(hello: { daemon: string; features: string[] }): { verdict: string };
export declare function resolveAtcPaths(env: object): { socketPath: string };
export type DaemonEvent = { kind: string };
export type PublishedRecord = { id: string };
`,
    `error TS2305: Module '"@atcx/contract"' has no exported member 'SessionID'.`,
  ],
])(
  'it fails a tarball with %s before npm publish, though npm holds its version',
  async (_label, entry, declarations, failure) => {
    const ctx = setupTest();

    await Bun.write(
      join(ctx.directory, 'tarball/package/package.json'),
      JSON.stringify({
        name: '@atcx/contract',
        version: '7.3.0',
        type: 'module',
        exports: { '.': './index.js', './light': './index.js' },
      }),
    );

    await Bun.write(join(ctx.directory, 'tarball/package/index.js'), entry);
    await Bun.write(join(ctx.directory, 'tarball/package/index.d.ts'), declarations);

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
      buildStubNpm(join(ctx.directory, 'npm.log'), '7.3.0', { installWith: ctx.npm }),
    );

    const published = await runCommand(
      ['bash', join(ctx.directory, 'scripts/publish-contract.sh'), '--dry-run'],
      { env: { ...process.env, PATH: `${join(ctx.directory, 'bin')}:${process.env['PATH']}` } },
    );

    expect({
      exitCode: published.exitCode,
      output: `${published.stdout}${published.stderr}`,
    }).toStrictEqual({ exitCode: 1, output: expect.stringContaining(failure) });

    expect(readFileSync(join(ctx.directory, 'npm.log'), 'utf8').split('\n')).toStrictEqual([
      expect.toStartWith('install --prefix '),
      '',
    ]);
  },
);
