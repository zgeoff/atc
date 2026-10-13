import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { buildTarArchive } from '@atc/core/build-tar-archive';

const gzipAsync = promisify(gzip);

// On a 102 MB release binary, level 6 sends 1 MB less than level 3 for
// about 0.5 s more CPU, which the process pays once and every copy reuses.
// Level 9 sends 1.2 MB less again but adds about 2.7 s to the first copy,
// more than a slow link saves on it.
const GZIP_LEVEL = 6;

// The binary does not change while the process runs, so each path is read
// and compressed once. A read that fails is dropped, so the next copy tries
// again.
const archives = new Map<string, Promise<Uint8Array>>();

/**
 * Reads the gzipped tar that installs the binary at `atcBinary` as
 * `bin/atc`, building it on the first call for that path and returning the
 * same bytes on every later one.
 */
export function readGuestATCArchive(atcBinary: string): Promise<Uint8Array> {
  const archive = archives.get(atcBinary) ?? readUncachedArchive(atcBinary);

  archives.set(atcBinary, archive);

  return archive;
}

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
