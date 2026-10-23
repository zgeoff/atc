import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

// A workspace package, named without its scope, the private `@atc/` or the
// published `@atcx/`, beside its full name: `deps` holds the workspace
// packages its manifest depends on, without their scopes.
export interface WorkspacePackage {
  readonly name: string;
  readonly packageName: string;
  readonly directory: string;
  readonly deps: readonly string[];
}

const SCOPED_NAME = /^@atcx?\//u;
const WORKSPACES_SCHEMA = z.object({ packages: z.array(z.string()) });
const ROOT_MANIFEST_SCHEMA = z.object({ workspaces: WORKSPACES_SCHEMA });

const PACKAGE_MANIFEST_SCHEMA = z.object({
  name: z.string().regex(SCOPED_NAME),
  dependencies: z.record(z.string(), z.string()).optional(),
});

// The packages that the root manifest's workspace globs match, sorted by directory.
export function loadWorkspacePackages(root: string): WorkspacePackage[] {
  const manifest = ROOT_MANIFEST_SCHEMA.parse(loadJSON(join(root, 'package.json')));

  const dirs = new Set<string>();

  for (const pattern of manifest.workspaces.packages) {
    for (const path of new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: root })) {
      dirs.add(dirname(path));
    }
  }

  return [...dirs].toSorted().map((directory) => {
    const pkg = PACKAGE_MANIFEST_SCHEMA.parse(loadJSON(join(root, directory, 'package.json')));
    const deps = Object.keys(pkg.dependencies ?? {}).filter((name) => SCOPED_NAME.test(name));

    return {
      name: pkg.name.replace(SCOPED_NAME, ''),
      packageName: pkg.name,
      directory,
      deps: deps.map((name) => name.replace(SCOPED_NAME, '')),
    };
  });
}

function loadJSON(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}
