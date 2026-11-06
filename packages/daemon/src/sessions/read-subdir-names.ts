import { readdir } from 'node:fs/promises';

// The names of the folders directly under a folder on the daemon's host, and of no symlink; none
// when the folder is not there.
export async function readSubdirNames(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });

    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}
