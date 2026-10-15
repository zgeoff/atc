// Writes .oxlintrc.imports.json, the oxlint overrides that hold each package
// to the package rules: no package outside its row, no deep import into
// another package's src/, no subpath of a package that its exports map does
// not list, no node: or bun: import in core, no test helper or testing entry
// in production code, and no confined package outside its owners. .oxlintrc.json extends the file. An override replaces a rule's
// options rather than merging them, and the last override that matches a
// file wins, so each override repeats every ban that holds for its files.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { PACKAGE_CONFINEMENT } from './package-confinement';
import type { PackageRule } from './package-rules';
import { PACKAGE_RULES } from './package-rules';

export const IMPORT_RULES_FILE = '.oxlintrc.imports.json';

interface RestrictedPath {
  readonly name: string;
  readonly importNames?: readonly string[];
  readonly message: string;
}

type RestrictedPattern =
  | { readonly regex: string; readonly message: string }
  | { readonly group: readonly string[]; readonly message: string };

interface RestrictionOptions {
  readonly paths: readonly RestrictedPath[];
  readonly patterns: readonly RestrictedPattern[];
}

interface Override {
  readonly files: readonly string[];
  readonly rules: { readonly 'no-restricted-imports': readonly ['error', RestrictionOptions] };
}

/**
 * The overrides file: per package a production override and a later test
 * override, the per-file exceptions after them, then e2e/ and scripts/.
 * `entries` holds each existing package's entry points, as its exports map
 * lists them, keyed by package name.
 */
export function buildImportRules(entries: ReadonlyMap<string, readonly string[]>): {
  readonly overrides: readonly Override[];
} {
  const overrides: Override[] = [];
  const entryPattern = buildEntryPattern(entries);

  for (const rule of PACKAGE_RULES) {
    // every module in the shared test helpers is test code
    const kind = rule.name === 'test-utils' ? 'test' : 'production';

    overrides.push(
      buildOverride([`${rule.dir}/**/*.ts`], buildPackageOptions(rule, kind, entryPattern)),
      buildOverride(
        [`${rule.dir}/**/*.test.ts`, `${rule.dir}/**/testing/**/*.ts`, ...getHelperGlobs(rule)],
        buildPackageOptions(rule, 'test', entryPattern),
      ),
    );
  }

  for (const confinement of PACKAGE_CONFINEMENT) {
    for (const file of confinement.exceptions) {
      const owner = PACKAGE_RULES.find((rule) => file.startsWith(`${rule.dir}/`));

      if (owner === undefined) {
        throw new Error(`no package holds the confinement exception ${file}`);
      }

      overrides.push(
        buildOverride(
          [file],
          buildPackageOptions(owner, 'test', entryPattern, confinement.specifier),
        ),
      );
    }
  }

  overrides.push(
    buildOverride(['e2e/**/*.ts', 'scripts/**/*.ts'], {
      paths: CHILD_PROCESS_PATHS,
      patterns: [DEEP_IMPORT, entryPattern, ...buildConfinementPatterns(null, 'test', null)],
    }),
  );

  return { overrides };
}

/**
 * One pattern that refuses every subpath of a package but the entry points
 * its exports map lists. oxlint's regular expressions take no lookahead, so
 * the pattern is a gitignore-style group: each package's subpaths at any
 * depth, minus each named entry. A package with no manifest yet has no
 * group, so the rules hold for it from the change that creates it.
 */
function buildEntryPattern(entries: ReadonlyMap<string, readonly string[]>): RestrictedPattern {
  const group: string[] = [];

  for (const [name, subpaths] of [...entries].toSorted(([a], [b]) => a.localeCompare(b))) {
    group.push(`${name}/*`, `${name}/*/**`);

    for (const subpath of subpaths.filter((candidate) => candidate !== '.')) {
      group.push(`!${name}/${subpath.slice(2)}`);
    }
  }

  return { group, message: 'Import a package through an entry point its exports map lists.' };
}

function buildOverride(files: readonly string[], options: RestrictionOptions): Override {
  return { files, rules: { 'no-restricted-imports': ['error', options] } };
}

// The app keeps its shared test helpers in its own test-utils folder until
// they move to the test-utils package.
function getHelperGlobs(rule: PackageRule): string[] {
  return rule.name === 'app' ? [`${rule.dir}/src/test-utils/**/*.ts`] : [];
}

type FileKind = 'production' | 'test';

/**
 * Every ban that holds for one kind of file in a package. `allowed` names a
 * confined package that the file may import as an exception.
 */
function buildPackageOptions(
  rule: PackageRule,
  kind: FileKind,
  entryPattern: RestrictedPattern,
  allowed: string | null = null,
): RestrictionOptions {
  const outside = PACKAGE_RULES.map((other) => other.name).filter(
    (name) => name !== rule.name && !rule.deps.includes(name),
  );

  // a test may use the shared helpers, and a front end's test the daemon's
  // testing entry: banning the daemon's root entry alone leaves that one,
  // since the daemon exports no other
  const bannedPackages =
    kind === 'test'
      ? outside.filter((name) => name !== 'test-utils' && !(rule.isFrontEnd && name === 'daemon'))
      : outside;

  const paths: RestrictedPath[] = [...CHILD_PROCESS_PATHS];

  if (kind === 'test' && rule.isFrontEnd && !rule.deps.includes('daemon')) {
    paths.push({
      name: '@atc/daemon',
      message: `A test in @atc/${rule.name} may use @atc/daemon/testing, never the daemon itself.`,
    });
  }

  const patterns: RestrictedPattern[] = [];

  if (bannedPackages.length > 0) {
    patterns.push({
      regex: `^@atc/(${bannedPackages.join('|')})(/|$)`,
      message: `@atc/${rule.name} may depend only on ${formatDeps(rule)}.`,
    });
  }

  patterns.push(DEEP_IMPORT, entryPattern);

  if (rule.name === 'core' && kind === 'production') {
    patterns.push({
      regex: '^(node|bun):',
      message: '@atc/core runs on any runtime: it imports no node: or bun: module.',
    });
  }

  if (kind === 'production') {
    patterns.push(
      {
        regex: '^@atc/test-utils(/|$)',
        message: 'Production code never imports the shared test helpers.',
      },
      {
        regex: '(^|/)testing(/|$)',
        message: 'Production code never imports a testing entry or a testing/ folder.',
      },
    );
  }

  patterns.push(...buildConfinementPatterns(rule.name, kind, allowed));

  return { paths, patterns };
}

function formatDeps(rule: PackageRule): string {
  return rule.deps.length === 0
    ? 'external packages'
    : rule.deps.map((d) => `@atc/${d}`).join(', ');
}

// Deep imports bypass a package's entry points.
const DEEP_IMPORT: RestrictedPattern = {
  regex: '^@atc/[^/]+/src(/|$)',
  message: 'Import a package through its entry points, never its src/ files.',
};

// The base config bans these synchronous spawns everywhere; an override
// replaces that rule's options, so every override repeats them.
const CHILD_PROCESS_MESSAGE =
  "Use an async spawn: Bun runs these through its synchronous spawn, which can lose a child's exit and hang (oven-sh/bun#34069).";

const CHILD_PROCESS_PATHS: readonly RestrictedPath[] = ['node:child_process', 'child_process'].map(
  (name) => ({
    name,
    importNames: ['spawnSync', 'execSync', 'execFileSync'],
    message: CHILD_PROCESS_MESSAGE,
  }),
);

/**
 * One pattern per confined package that the package does not own. `owner`
 * is null for files outside every workspace package.
 */
function buildConfinementPatterns(
  owner: string | null,
  kind: FileKind,
  allowed: string | null,
): RestrictedPattern[] {
  return PACKAGE_CONFINEMENT.filter(
    (confinement) =>
      (owner === null || !confinement.owners.includes(owner)) &&
      (kind === 'production' || confinement.inTests) &&
      confinement.specifier !== allowed,
  ).map((confinement) => ({
    regex: `^${confinement.specifier}(/|$)`,
    message:
      confinement.owners.length === 0
        ? `No file imports ${confinement.specifier}.`
        : `${confinement.specifier} belongs to ${confinement.owners.map((name) => `@atc/${name}`).join(', ')}.`,
  }));
}

const MANIFEST_SCHEMA = z.object({
  name: z.string(),
  exports: z.record(z.string(), z.unknown()).optional(),
});

/**
 * The entry points of each package in the package rules whose manifest
 * exists, as its exports map lists them, keyed by package name.
 */
export function collectEntries(root: string): Map<string, readonly string[]> {
  const entries = new Map<string, readonly string[]>();

  for (const rule of PACKAGE_RULES) {
    const path = join(root, rule.dir, 'package.json');

    if (existsSync(path)) {
      const manifest = MANIFEST_SCHEMA.parse(JSON.parse(readFileSync(path, 'utf8')));

      entries.set(manifest.name, Object.keys(manifest.exports ?? {}));
    }
  }

  return entries;
}

async function main(): Promise<void> {
  const root = join(import.meta.dir, '..');
  const rules = buildImportRules(collectEntries(root));

  await Bun.write(join(root, IMPORT_RULES_FILE), `${JSON.stringify(rules, null, 2)}\n`);
}

if (import.meta.main) {
  await main();
}
