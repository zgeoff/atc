import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { collectPackageClosure } from './collect-package-closure';
import type { WorkspacePackage } from './load-workspace-packages';
import { loadWorkspacePackages } from './load-workspace-packages';
import { readOptionalText } from './read-optional-text';
import { readWorkerCount } from './read-worker-count';

// A plugin that reaches past its rule must fail, so its tests run in a workspace holding only what it needs.

// The Claude harness embeds the atc-bridge mod and checks against it.
const SETUP_PATHS = ['bunfig.toml', 'tsconfig.base.json', 'scripts/with-test-home.sh', 'mods'];

const TOOLING = new Set([
  '@commitlint/cli',
  '@stylistic/eslint-plugin',
  '@zgeoff/format-codemod',
  '@zgeoff/oxlint-config',
  'knip',
  'lefthook',
  'oxfmt',
  'oxlint',
]);

async function main(): Promise<void> {
  const args = parseArgs({
    args: process.argv.slice(2),
    options: { keep: { type: 'boolean', default: false } },
    allowPositionals: true,
  });

  const [name, root] = args.positionals;
  const repo = resolve(root ?? join(import.meta.dir, '..'));
  const keep = args.values.keep;
  const workspace = loadWorkspacePackages(repo);
  const plugins = workspace.filter((pkg) => isPlugin(pkg));
  const plugin = plugins.find((pkg) => pkg.name === name);

  if (plugin === undefined) {
    printUsage(plugins);

    process.exit(2);
  }

  const workers = await readWorkerCount({
    env: process.env,
    cores: availableParallelism(),
    totalMemory: totalmem(),
    procRoot: '/proc',
    cgroupRoot: '/sys/fs/cgroup',
    readText: readOptionalText,
  });

  if (workers.kind === 'invalid') {
    console.error(`test-plugin: ${workers.message}`);
    process.exit(2);
  }

  const packages = collectPackageClosure(workspace, [
    plugin.name,
    ...readDevPackageNames(repo, plugin, workspace),
  ]);

  const directory = mkdtempSync(join(tmpdir(), `atc-test-plugin-${plugin.name}-`));

  try {
    createPluginWorkspace({ repo, directory, plugin, packages, workspace });

    const steps: readonly (readonly string[])[] = [
      ['bun', 'install'],

      // tsc's shebang finds `node` on PATH, which can be a version-manager shim
      // that fails to read its own state under the test home
      ['bun', 'node_modules/.bin/tsc', '-p', 'tsconfig.json', '--noEmit'],
      [
        'bash',
        'scripts/with-test-home.sh',
        'bun',
        'test',
        `--parallel=${workers.count}`,
        '--no-isolate',
        plugin.directory,
      ],
    ];

    let passed = true;

    for (const argv of steps) {
      if (!passed) {
        break;
      }

      const stepPassed = await runStep(directory, argv);

      passed = stepPassed;
    }

    const outcome = passed ? 'passed in a workspace without the app' : 'failed';

    console.log(`test-plugin: ${plugin.name} ${outcome}`);

    process.exitCode = passed ? 0 : 1;
  } finally {
    if (keep) {
      console.log(`test-plugin: kept ${directory}`);
    } else {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

function readDevPackageNames(
  repo: string,
  plugin: WorkspacePackage,
  workspace: readonly WorkspacePackage[],
): string[] {
  const text = readFileSync(join(repo, plugin.directory, 'package.json'), 'utf8');

  const manifest = z
    .object({ devDependencies: z.record(z.string(), z.string()).optional() })
    .parse(JSON.parse(text));

  return Object.keys(manifest.devDependencies ?? {}).flatMap((name) => {
    const pkg = workspace.find((candidate) => candidate.packageName === name);

    return pkg === undefined ? [] : [pkg.name];
  });
}

function isPlugin(rule: WorkspacePackage): boolean {
  return ['harness-', 'execution-', 'source-'].some((prefix) => rule.name.startsWith(prefix));
}

function printUsage(plugins: readonly WorkspacePackage[]): void {
  console.error(
    `usage: bun run test:plugin <plugin>, where <plugin> is one of: ${plugins.map((rule) => rule.name).join(', ')}`,
  );
}

interface CreatePluginWorkspaceOptions {
  readonly repo: string;
  readonly directory: string;
  readonly plugin: WorkspacePackage;
  readonly packages: readonly WorkspacePackage[];
  readonly workspace: readonly WorkspacePackage[];
}

function createPluginWorkspace(options: CreatePluginWorkspaceOptions): void {
  for (const rule of options.packages) {
    cpSync(join(options.repo, rule.directory), join(options.directory, rule.directory), {
      recursive: true,
      filter: (source) => !source.includes('/node_modules'),
    });
  }

  for (const path of SETUP_PATHS) {
    cpSync(join(options.repo, path), join(options.directory, path), { recursive: true });
  }

  writeWorkspaceManifest(options.repo, options.directory, options.packages, options.workspace);

  writeFileSync(
    join(options.directory, 'tsconfig.json'),
    `${JSON.stringify(
      {
        extends: './tsconfig.base.json',
        compilerOptions: { types: ['bun', '@zgeoff/bun-test-extended'] },
        include: options.packages.map((rule) => `${rule.directory}/src/**/*.ts`),
        exclude: options.packages
          .filter((rule) => rule !== options.plugin)
          .map((rule) => `${rule.directory}/src/**/*.test.ts`),
      },
      null,
      2,
    )}\n`,
  );
}

function writeWorkspaceManifest(
  repo: string,
  directory: string,
  packages: readonly WorkspacePackage[],
  workspace: readonly WorkspacePackage[],
): void {
  const text = readFileSync(join(repo, 'package.json'), 'utf8');
  const manifest = z.record(z.string(), z.unknown()).parse(JSON.parse(text));

  const copied = new Set(packages.map((rule) => rule.packageName));
  const internal = new Set(workspace.map((rule) => rule.packageName));

  const declared = manifest['devDependencies'];
  const devDependencies = isStringRecord(declared) ? declared : {};

  const kept = Object.fromEntries(
    Object.entries(devDependencies).filter(
      ([name]) => !TOOLING.has(name) && (!internal.has(name) || copied.has(name)),
    ),
  );

  const {
    scripts: _scripts,
    patchedDependencies: _patches,
    devDependencies: _devDependencies,
    ...rest
  } = manifest;

  writeFileSync(
    join(directory, 'package.json'),
    `${JSON.stringify({ ...rest, devDependencies: kept }, null, 2)}\n`,
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

async function runStep(directory: string, argv: readonly string[]): Promise<boolean> {
  console.log(`test-plugin: ${argv.join(' ')}`);

  const child = Bun.spawn([...argv], { cwd: directory, stdio: ['ignore', 'inherit', 'inherit'] });

  const code = await child.exited;

  if (code !== 0) {
    console.error(`test-plugin: ${argv.join(' ')} exited with ${code}`);
  }

  return code === 0;
}

await main();
