import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubNpm } from '@atc/core/test-utils/build-stub-npm';
import { createStubBin } from '@atc/core/test-utils/create-stub-bin';
import { runCommand } from '@atc/core/test-utils/run-command';
import { setupTempDir } from '@atc/core/test-utils/setup-temp-dir';
import invariant from 'tiny-invariant';

// The real repository packs and checks the real packages. The stand-in npm records every call and
// passes the installs and the packs on to the real npm, so the registry never sees a publish.
function setupTest() {
  const temporaryDirectory = setupTempDir('publish-contract-toolchain-');
  const npm = Bun.which('npm');
  const directory = temporaryDirectory.path;
  const root = join(import.meta.dir, '..');

  invariant(npm !== null, 'the toolchain lane needs npm on PATH');
  mkdirSync(join(directory, 'scripts'));

  for (const script of [
    'publish-contract.sh',
    'publish-tarball.sh',
    'check-tarball-imports.mjs',
    'smoke-client.mjs',
    'serve-stub-daemon.ts',
  ]) {
    symlinkSync(join(root, 'scripts', script), join(directory, 'scripts', script));
  }

  symlinkSync(join(root, 'package.json'), join(directory, 'package.json'));

  const manifest: unknown = JSON.parse(
    readFileSync(join(root, 'packages/contract/package.json'), 'utf8'),
  );

  invariant(
    typeof manifest === 'object' && manifest !== null && 'version' in manifest,
    'the contract manifest holds a version',
  );

  const version = String(manifest.version);

  const writeNpm = (heldVersion: string | null) =>
    createStubBin(
      join(directory, 'bin'),
      'npm',
      buildStubNpm(join(directory, 'npm.log'), heldVersion, { installWith: npm }),
    );

  return {
    directory,
    root,
    version,
    writeNpm,
    env: { ...process.env, PATH: `${join(directory, 'bin')}:${process.env['PATH']}` },

    // packs one package as a stand-in tarball, and the other through the real packer
    packerScript: (fake: 'contract' | 'client' | 'neither') => `const args = process.argv.slice(2);
const name = args[args.indexOf('--package') + 1];
if (name === ${JSON.stringify(fake)}) {
  console.log(${JSON.stringify(directory)} + '/tarball/' + name + '/' + name + '.tgz');
} else {
  const real = Bun.spawnSync(
    ['bun', ${JSON.stringify(join(root, 'scripts/pack-contract.ts'))}, '--out', args[args.indexOf('--out') + 1], '--package', name, ${JSON.stringify(root)}],
    { stdout: 'inherit', stderr: 'inherit' },
  );
  process.exit(real.exitCode);
}
`,
  };
}

test('it packs both packages, installs the tarballs, connects from Node and from Bun, and runs npm publish as a dry run', async () => {
  const ctx = setupTest();

  ctx.writeNpm(null);

  await Bun.write(join(ctx.directory, 'scripts/pack-contract.ts'), ctx.packerScript('neither'));

  const published = await runCommand(
    ['bash', join(ctx.directory, 'scripts/publish-contract.sh'), '--dry-run'],
    { env: ctx.env },
  );

  const calls = readFileSync(join(ctx.directory, 'npm.log'), 'utf8').split('\n');

  expect(published.exitCode).toBe(0);
  expect(published.stdout).toInclude('connects to the daemon, sends, and reads an event');
  expect(published.stdout).toMatch(/^node \d+\.\d+\.\d+ connects/mu);
  expect(published.stdout).toMatch(/^bun \d+\.\d+\.\d+ connects/mu);

  expect(calls).toStrictEqual([
    expect.toStartWith('pack --pack-destination '),
    expect.toStartWith('pack --pack-destination '),
    expect.toStartWith('install --prefix '),
    `view @atcx/contract@${ctx.version} version`,
    expect.stringMatching(/^publish .*atcx-contract-.*\.tgz --access public --dry-run$/u),
    `view @atcx/client@${ctx.version} version`,
    expect.stringMatching(/^publish .*atcx-client-.*\.tgz --access public --dry-run$/u),
    '',
  ]);
});

test('it checks both packages, then skips npm publish for the versions npm holds already', async () => {
  const ctx = setupTest();

  ctx.writeNpm(ctx.version);

  await Bun.write(join(ctx.directory, 'scripts/pack-contract.ts'), ctx.packerScript('neither'));

  const published = await runCommand(
    ['bash', join(ctx.directory, 'scripts/publish-contract.sh'), '--dry-run'],
    { env: ctx.env },
  );

  expect({ exitCode: published.exitCode, stdout: published.stdout }).toStrictEqual({
    exitCode: 0,
    stdout: expect.toEndWith(
      `@atcx/contract@${ctx.version} is on npm already\n@atcx/client@${ctx.version} is on npm already\n`,
    ),
  });

  expect(readFileSync(join(ctx.directory, 'npm.log'), 'utf8')).not.toInclude('publish ');
});

test('it fails a contract tarball whose JavaScript entry lacks checkDaemon before npm publish', async () => {
  const ctx = setupTest();

  ctx.writeNpm(null);

  await Bun.write(
    join(ctx.directory, 'tarball/contract/package/package.json'),
    JSON.stringify({
      name: '@atcx/contract',
      version: ctx.version,
      type: 'module',
      files: ['dist'],
      exports: { '.': './dist/index.js', './light': './dist/index.js' },
    }),
  );

  await Bun.write(
    join(ctx.directory, 'tarball/contract/package/dist/index.js'),
    `export const DAEMON_FEATURES = ['sessions'];
export function resolveAtcPaths() { return { socketPath: '/run/atc.sock' }; }
`,
  );

  await runCommand(['tar', '-czf', 'contract.tgz', 'package'], {
    cwd: join(ctx.directory, 'tarball/contract'),
  });

  await Bun.write(join(ctx.directory, 'scripts/pack-contract.ts'), ctx.packerScript('contract'));

  const published = await runCommand(
    ['bash', join(ctx.directory, 'scripts/publish-contract.sh'), '--dry-run'],
    { env: ctx.env },
  );

  expect({
    exitCode: published.exitCode,
    output: `${published.stdout}${published.stderr}`,
  }).toStrictEqual({
    exitCode: 1,
    output: expect.stringContaining('contract.checkDaemon is not a function'),
  });

  expect(readFileSync(join(ctx.directory, 'npm.log'), 'utf8')).not.toInclude('publish ');
});

test('it fails a client tarball whose declarations lack AtcError before npm publish', async () => {
  const ctx = setupTest();

  ctx.writeNpm(null);

  await Bun.write(
    join(ctx.directory, 'tarball/client/package/package.json'),
    JSON.stringify({
      name: '@atcx/client',
      version: ctx.version,
      type: 'module',
      files: ['dist'],
      exports: {
        '.': { types: './dist/index.d.ts', default: './dist/index.js' },
        './connection': { types: './dist/connection.d.ts', default: './dist/connection.js' },
      },
    }),
  );

  await Bun.write(
    join(ctx.directory, 'tarball/client/package/dist/index.js'),
    `export class AtcError extends Error { constructor(code) { super(code); this.code = code; } }
export async function connect() { return {}; }
export async function readDaemonSocketPaths() { return []; }
`,
  );

  await Bun.write(
    join(ctx.directory, 'tarball/client/package/dist/index.d.ts'),
    `export declare function connect(options?: object): Promise<object>;
export declare function readDaemonSocketPaths(paths: object): Promise<string[]>;
`,
  );

  await Bun.write(
    join(ctx.directory, 'tarball/client/package/dist/connection.js'),
    'export async function openDaemonConnection() { return {}; }\n',
  );

  await Bun.write(
    join(ctx.directory, 'tarball/client/package/dist/connection.d.ts'),
    'export declare function openDaemonConnection(): Promise<object>;\n',
  );

  await runCommand(['tar', '-czf', 'client.tgz', 'package'], {
    cwd: join(ctx.directory, 'tarball/client'),
  });

  await Bun.write(join(ctx.directory, 'scripts/pack-contract.ts'), ctx.packerScript('client'));

  const published = await runCommand(
    ['bash', join(ctx.directory, 'scripts/publish-contract.sh'), '--dry-run'],
    { env: ctx.env },
  );

  expect({
    exitCode: published.exitCode,
    output: `${published.stdout}${published.stderr}`,
  }).toStrictEqual({
    exitCode: 1,
    output: expect.stringContaining(
      `error TS2305: Module '"@atcx/client"' has no exported member 'AtcError'.`,
    ),
  });

  expect(readFileSync(join(ctx.directory, 'npm.log'), 'utf8')).not.toInclude('publish ');
});
