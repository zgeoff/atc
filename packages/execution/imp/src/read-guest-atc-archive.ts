import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { buildTarArchive } from '@atc/core';

// The binary does not change while the process runs, so each path is read
// and compressed once. A read that fails is dropped, so the next copy tries
// again.
const archives = new Map<string, Promise<Uint8Array>>();

export function readGuestATCArchive(atcBinary: string): Promise<Uint8Array> {
  const archive = archives.get(atcBinary) ?? readUncachedArchive(atcBinary);

  archives.set(atcBinary, archive);

  return archive;
}

// On a 102 MB binary, level 6 sends 1 MB less than level 3 for about 0.5 s
// more CPU, paid once per process. Level 9 saves 1.2 MB more but adds about
// 2.7 s to the first copy, more than a slow link saves on it.
const GZIP_LEVEL = 6;
const gzipAsync = promisify(gzip);

async function readUncachedArchive(atcBinary: string): Promise<Uint8Array> {
  try {
    const binary = await Bun.file(atcBinary).bytes();

    const tar = buildTarArchive([{ path: 'bin/atc', content: binary, mode: 0o755 }]);

    return await gzipAsync(tar, { level: GZIP_LEVEL });
  } catch (error) {
    archives.delete(atcBinary);
    throw error;
  }
}
