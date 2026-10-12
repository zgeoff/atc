import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs'];

// Every source module under the directory, in sorted order, skipping
// installed packages; a directory that does not exist holds none.
export function collectSourceFiles(root: string, dir: string): string[] {
  const files: string[] = [];

  if (!existsSync(join(root, dir))) {
    return files;
  }

  for (const entry of readdirSync(join(root, dir)).toSorted()) {
    const path = `${dir}/${entry}`;

    if (entry === 'node_modules') {
      continue;
    }

    if (statSync(join(root, path)).isDirectory()) {
      files.push(...collectSourceFiles(root, path));
    } else if (SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension))) {
      files.push(path);
    }
  }

  return files;
}
