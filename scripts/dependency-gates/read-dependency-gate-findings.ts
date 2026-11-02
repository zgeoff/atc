import type { RunProgram } from '../run-program.ts';
import { collectMissingFirstPartyExcludes } from './collect-missing-first-party-excludes.ts';
import { collectStaleAgeGateExcludes } from './collect-stale-age-gate-excludes.ts';
import { collectUnneededAuditIgnores } from './collect-unneeded-audit-ignores.ts';
import { collectUnneededOverrides } from './collect-unneeded-overrides.ts';
import { parseAgeGate } from './parse-age-gate.ts';
import { parseAuditAdvisories } from './parse-audit-advisories.ts';
import { parseAuditIgnoreIDs } from './parse-audit-ignore-ids.ts';
import { parseFixablePackages } from './parse-fixable-packages.ts';
import { parseLockfileDependents } from './parse-lockfile-dependents.ts';
import { parseLockfileRegistryNames } from './parse-lockfile-registry-names.ts';
import type { RootManifest } from './parse-root-manifest.ts';
import { parseRootManifest } from './parse-root-manifest.ts';
import type { DependencyGateFinding } from './types.ts';

export interface DependencyGateSources {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;

  // An ISO date, such as 2026-03-08.
  readonly today: string;

  readonly runProgram: RunProgram;

  // The path is relative to the repo root.
  readonly readRepoFile: (path: string) => string | null;
}

// The audit runs only for a repo that ignores an advisory, so a repo with no ignore needs no
// network.
export function readDependencyGateFindings(
  sources: Readonly<DependencyGateSources>,
): DependencyGateFinding[] {
  const manifestText = sources.readRepoFile('package.json');

  if (manifestText === null) {
    throw new Error('the repo has no package.json');
  }

  const manifest = parseRootManifest(manifestText);
  const ignoreIDs = parseAuditIgnoreIDs(manifest.auditScript);
  const bunfig = sources.readRepoFile('bunfig.toml') ?? '';
  const lockfile = sources.readRepoFile('bun.lock');

  return [
    ...collectStaleAgeGateExcludes(bunfig, sources.today),
    ...(lockfile === null
      ? []
      : collectMissingFirstPartyExcludes(
          parseAgeGate(bunfig),
          parseLockfileRegistryNames(lockfile),
        )),
    ...collectOverrideFindings(manifest, lockfile),
    ...(ignoreIDs.length === 0 ? [] : readIgnoreFindings(sources, ignoreIDs)),
  ];
}

function collectOverrideFindings(
  manifest: RootManifest,
  lockfile: string | null,
): DependencyGateFinding[] {
  if (Object.keys(manifest.overrides).length === 0) {
    return [];
  }

  if (lockfile === null) {
    throw new Error('package.json sets overrides, and the repo has no bun.lock');
  }

  return collectUnneededOverrides({
    overrides: manifest.overrides,
    catalog: manifest.catalog,
    catalogs: manifest.catalogs,
    dependents: parseLockfileDependents(lockfile),
  });
}

function readIgnoreFindings(
  sources: Readonly<DependencyGateSources>,
  ignoreIDs: readonly string[],
): DependencyGateFinding[] {
  return collectUnneededAuditIgnores({
    ignoreIDs,
    advisories: parseAuditAdvisories(runBun(sources, ['audit', '--json'])),
    fixablePackages: parseFixablePackages(runBun(sources, ['audit', 'fix', '--dry-run', '--json'])),
  });
}

// `bun audit` exits 1 while any advisory remains, ignored ones included, so only empty output fails.
function runBun(sources: Readonly<DependencyGateSources>, args: readonly string[]): string {
  const result = sources.runProgram(['bun', ...args], { cwd: sources.cwd, env: sources.env });

  if (result.stdout.trim() === '') {
    throw new Error(
      `bun ${args.join(' ')} printed nothing and exited ${result.exitCode}: ${result.stderr.trim()}`,
    );
  }

  return result.stdout;
}
