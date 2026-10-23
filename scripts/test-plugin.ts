import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { collectPackageClosure } from './collect-package-closure';
import type { WorkspacePackage } from './load-workspace-packages';
import { loadWorkspacePackages } from './load-workspace-packages';

// Tests one plugin package in a workspace holding only it, the packages its
// rule reaches and the test helpers, so a plugin that reaches past its rule
// fails. Usage: bun scripts/test-plugin.ts <plugin> [root] [--keep], such as harness-claude

// The root files the test setup reads: the install and test config, the
// compiler config, the script that gives each run its own home, and the
// atc-bridge mod, which the Claude harness embeds and checks against.
const SETUP_PATHS = ['bunfig.toml', 'tsconfig.base.json', 'scripts/with-test-home.sh', 'mods'];

// The root development tools that only lint, format, or hook commits.
const TOOLING = new Set([
  '@commitlint/cli',
  '@stylistic/eslint-plugin',
  '@zgeoff/format-codemod',
  '@zgeoff/oxlint-config',
  'knip',
  'lefthook',
  'oxfmt',
  'oxlint',
  'oxlint-tsgolint',
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

  // the plugin, and the shared test helpers its tests import
  const packages = collectPackageClosure(workspace, [plugin.name, 'test-utils']);
  const directory = mkdtempSync(join(tmpdir(), `atc-test-plugin-${plugin.name}-`));

  try {
    createPluginWorkspace(repo, directory, plugin, packages, workspace);

    const steps: readonly (readonly string[])[] = [
      ['bun', 'install'],

      // tsc's shebang finds `node` on PATH, which can be a version-manager shim
      // that fails to read its own state under the test home
      ['bun', 'node_modules/.bin/tsc', '-p', 'tsconfig.json', '--noEmit'],
      ['bash', 'scripts/with-test-home.sh', 'bun', 'test', plugin.directory],
    ];

    let passed = true;

    for (const argv of steps) {
      if (!passed) {
        break;
      }

      // each step needs the one before it
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

function isPlugin(rule: WorkspacePackage): boolean {
  return ['harness-', 'execution-', 'source-'].some((prefix) => rule.name.startsWith(prefix));
}

function printUsage(plugins: readonly WorkspacePackage[]): void {
  console.error(
    `usage: bun run test:plugin <plugin>, where <plugin> is one of: ${plugins.map((rule) => rule.name).join(', ')}`,
  );
}

// The workspace's type check covers the plugin and the production files of
// the packages it reaches. The other packages' own tests may import the
// app, which the workspace leaves out.
function createPluginWorkspace(
  repo: string,
  directory: string,
  plugin: WorkspacePackage,
  packages: readonly WorkspacePackage[],
  workspace: readonly WorkspacePackage[],
): void {
  for (const rule of packages) {
    cpSync(join(repo, rule.directory), join(directory, rule.directory), {
      recursive: true,
      filter: (source) => !source.includes('/node_modules'),
    });
  }

  for (const path of SETUP_PATHS) {
    cpSync(join(repo, path), join(directory, path), { recursive: true });
  }

  writeWorkspaceManifest(repo, directory, packages, workspace);

  writeFileSync(
    join(directory, 'tsconfig.json'),
    `${JSON.stringify(
      {
        extends: './tsconfig.base.json',
        compilerOptions: { types: ['bun', '@zgeoff/bun-test-extended'] },
        include: packages.map((rule) => `${rule.directory}/src/**/*.ts`),
        exclude: packages
          .filter((rule) => rule !== plugin)
          .map((rule) => `${rule.directory}/src/**/*.test.ts`),
      },
      null,
      2,
    )}\n`,
  );
}

// The root manifest without the scripts, the commit and lint tooling, the
// patches that only that tooling needs, and the internal packages the
// workspace leaves out.
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

// Runs one step in the workspace with its output on this process's, and
// whether it exited 0.
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
