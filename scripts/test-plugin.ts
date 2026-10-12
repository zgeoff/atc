import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { PACKAGE_RULES } from './package-rules';
import type { PackageRule } from './package-rules';

// Builds one plugin package in a workspace of its own, holding the plugin,
// the internal packages its rule lets it import, the shared test helpers,
// and the repo's test setup, and nothing else: no app, no daemon. In that
// workspace it installs, type-checks, and runs the plugin's tests, so a
// plugin that reaches past its rule, or whose tests need a daemon, fails.
// Usage: bun scripts/test-plugin.ts <plugin> [--keep], where <plugin> is a
// package rule's name, such as harness-claude.

const repo = join(import.meta.dir, '..');

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
  const name = process.argv.at(2);
  const keep = process.argv.includes('--keep');
  const plugins = PACKAGE_RULES.filter((rule) => isPlugin(rule));
  const plugin = plugins.find((rule) => rule.name === name);

  if (plugin === undefined) {
    printUsage(plugins);

    process.exit(2);
  }

  const packages = collectPackageClosure(plugin);
  const dir = mkdtempSync(join(tmpdir(), `atc-test-plugin-${plugin.name}-`));

  try {
    createPluginWorkspace(dir, plugin, packages);

    const steps: readonly (readonly string[])[] = [
      ['bun', 'install'],
      ['node_modules/.bin/tsc', '-p', 'tsconfig.json', '--noEmit'],
      ['bash', 'scripts/with-test-home.sh', 'bun', 'test', plugin.dir],
    ];

    let passed = true;

    for (const argv of steps) {
      if (!passed) {
        break;
      }

      // each step needs the one before it
      const stepPassed = await runStep(dir, argv);

      passed = stepPassed;
    }

    const outcome = passed ? 'passed in a workspace without the app' : 'failed';

    console.log(`test-plugin: ${plugin.name} ${outcome}`);

    process.exitCode = passed ? 0 : 1;
  } finally {
    if (keep) {
      console.log(`test-plugin: kept ${dir}`);
    } else {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

function isPlugin(rule: PackageRule): boolean {
  return ['harness-', 'execution-', 'source-'].some((prefix) => rule.name.startsWith(prefix));
}

function printUsage(plugins: readonly PackageRule[]): void {
  console.error(
    `usage: bun run test:plugin <plugin>, where <plugin> is one of: ${plugins.map((rule) => rule.name).join(', ')}`,
  );
}

// The plugin, every package its rule reaches, and the shared test helpers
// with every package theirs reaches.
function collectPackageClosure(plugin: PackageRule): PackageRule[] {
  const found = new Map<string, PackageRule>();

  const pending = [plugin.name, 'test-utils'];

  while (pending.length > 0) {
    const name = pending.pop();
    const rule = PACKAGE_RULES.find((candidate) => candidate.name === name);

    if (rule !== undefined && !found.has(rule.name)) {
      found.set(rule.name, rule);
      pending.push(...rule.deps);
    }
  }

  return [...found.values()];
}

// The workspace's type check covers the plugin and the production files of
// the packages it reaches. The other packages' own tests may import the
// app, which the workspace leaves out.
function createPluginWorkspace(
  dir: string,
  plugin: PackageRule,
  packages: readonly PackageRule[],
): void {
  for (const rule of packages) {
    cpSync(join(repo, rule.dir), join(dir, rule.dir), {
      recursive: true,
      filter: (source) => !source.includes('/node_modules'),
    });
  }

  for (const path of SETUP_PATHS) {
    cpSync(join(repo, path), join(dir, path), { recursive: true });
  }

  writeWorkspaceManifest(dir, packages);

  writeFileSync(
    join(dir, 'tsconfig.json'),
    `${JSON.stringify(
      {
        extends: './tsconfig.base.json',
        compilerOptions: { types: ['bun', '@zgeoff/bun-test-extended'] },
        include: packages.map((rule) => `${rule.dir}/src/**/*.ts`),
        exclude: packages
          .filter((rule) => rule !== plugin)
          .map((rule) => `${rule.dir}/src/**/*.test.ts`),
      },
      null,
      2,
    )}\n`,
  );
}

// The root manifest without the scripts, the commit and lint tooling, the
// patches that only that tooling needs, and the internal packages the
// workspace leaves out.
function writeWorkspaceManifest(dir: string, packages: readonly PackageRule[]): void {
  const text = readFileSync(join(repo, 'package.json'), 'utf8');
  const manifest = z.record(z.string(), z.unknown()).parse(JSON.parse(text));

  const copied = new Set(packages.map((rule) => `@atc/${rule.name}`));

  const declared = manifest['devDependencies'];
  const devDependencies = isStringRecord(declared) ? declared : {};

  const kept = Object.fromEntries(
    Object.entries(devDependencies).filter(
      ([name]) => !TOOLING.has(name) && (!name.startsWith('@atc/') || copied.has(name)),
    ),
  );

  const {
    scripts: _scripts,
    patchedDependencies: _patches,
    devDependencies: _devDependencies,
    ...rest
  } = manifest;

  writeFileSync(
    join(dir, 'package.json'),
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
async function runStep(dir: string, argv: readonly string[]): Promise<boolean> {
  console.log(`test-plugin: ${argv.join(' ')}`);

  const child = Bun.spawn([...argv], { cwd: dir, stdio: ['ignore', 'inherit', 'inherit'] });

  const code = await child.exited;

  if (code !== 0) {
    console.error(`test-plugin: ${argv.join(' ')} exited with ${code}`);
  }

  return code === 0;
}

await main();
