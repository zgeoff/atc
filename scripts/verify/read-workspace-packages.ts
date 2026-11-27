import { join } from 'node:path';
import { z } from 'zod';
import type { WorkspacePackage } from './types.ts';

const workspacesSchema = z.object({ packages: z.array(z.string()) });
const rootJSONSchema = z.object({ workspaces: workspacesSchema });

const packageJSONSchema = z.object({
  name: z.string(),
  dependencies: z.record(z.string(), z.string()).optional(),
});

// Each package that the root `package.json` names as a workspace, with the names of the workspace
// packages it depends on at run time.
export async function readWorkspacePackages(rootDir: string): Promise<WorkspacePackage[]> {
  const rootJSON: unknown = await Bun.file(join(rootDir, 'package.json')).json();

  const patterns = rootJSONSchema.parse(rootJSON).workspaces.packages;
  const packages: WorkspacePackage[] = [];

  for (const pattern of patterns) {
    for await (const path of new Bun.Glob(`${pattern}/package.json`).scan({ cwd: rootDir })) {
      const packageJSON: unknown = await Bun.file(join(rootDir, path)).json();

      const parsed = packageJSONSchema.parse(packageJSON);

      packages.push({
        folder: path.slice(0, -'/package.json'.length),
        name: parsed.name,
        workspaceDependencies: Object.entries(parsed.dependencies ?? {})
          .filter(([, version]) => version.startsWith('workspace:'))
          .map(([name]) => name),
      });
    }
  }

  return packages.toSorted((first, second) => first.folder.localeCompare(second.folder));
}
