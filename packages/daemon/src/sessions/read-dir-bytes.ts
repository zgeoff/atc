import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function readDirBytes(directory: string): Promise<number | null> {
  try {
    return await readEntryBytes(directory);
  } catch {
    return null;
  }
}

// The bytes a stat's block count stands for, which POSIX fixes at 512 whatever the filesystem's
// own block size.
const STAT_BLOCK_BYTES = 512;

async function readEntryBytes(path: string): Promise<number> {
  const stats = await lstat(path);

  if (!stats.isDirectory()) {
    return stats.blocks * STAT_BLOCK_BYTES;
  }

  let total = stats.blocks * STAT_BLOCK_BYTES;

  for (const name of await readdir(path)) {
    total += await readEntryBytes(join(path, name));
  }

  return total;
}
