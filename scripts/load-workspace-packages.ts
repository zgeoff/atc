import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

// A workspace package, named without the `@atc/` scope: `deps` holds the
// workspace packages its manifest depends on, in the same form.
export interface WorkspacePackage {
  readonly name: string;
  readonly dir: string;
  readonly deps: readonly string[];
}

// The packages that the root manifest's workspace globs match, sorted by directory.
export function loadWorkspacePackages(root: string): WorkspacePackage[] {
  const manifest = ROOT_MANIFEST_SCHEMA.parse(readJSON(join(root, 'package.json')));

  const dirs = new Set<string>();

  for (const pattern of manifest.workspaces.packages) {
    for (const path of new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: root })) {
      dirs.add(dirname(path));
    }
  }

  return [...dirs].toSorted().map((dir) => {
    const pkg = PACKAGE_MANIFEST_SCHEMA.parse(readJSON(join(root, dir, 'package.json')));
    const deps = Object.keys(pkg.dependencies ?? {}).filter((name) => name.startsWith(SCOPE));

    return {
      name: pkg.name.slice(SCOPE.length),
      dir,
      deps: deps.map((name) => name.slice(SCOPE.length)),
    };
  });
}

function readJSON(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const SCOPE = '@atc/';
const WORKSPACES_SCHEMA = z.object({ packages: z.array(z.string()) });
const ROOT_MANIFEST_SCHEMA = z.object({ workspaces: WORKSPACES_SCHEMA });

const PACKAGE_MANIFEST_SCHEMA = z.object({
  name: z.string().startsWith(SCOPE),
  dependencies: z.record(z.string(), z.string()).optional(),
});
