/**
 * One file in an archive: its path relative to the directory it unpacks
 * into, its bytes, and its permission bits.
 */
export interface ArchiveFile {
  readonly path: string;
  readonly content: string | Uint8Array;
  readonly mode?: number;
}

const BLOCK = 512;

/**
 * Packs files into a POSIX ustar archive that `tar -x` unpacks, each with
 * its parent directories created on the way. A path longer than 100 bytes
 * splits at a slash into ustar's prefix and name fields, and a path that
 * fits no such split is refused.
 */
// oxlint-disable-next-line prefer-readonly-parameter-types -- file bytes have no readonly form
export function buildTarArchive(files: readonly ArchiveFile[]): Uint8Array {
  const encoder = new TextEncoder();

  const blocks: Uint8Array[] = [];

  for (const file of files) {
    const content = typeof file.content === 'string' ? encoder.encode(file.content) : file.content;

    blocks.push(
      buildHeader(file.path, content.length, file.mode ?? 0o644),
      content,
      new Uint8Array((BLOCK - (content.length % BLOCK)) % BLOCK),
    );
  }

  // Two empty blocks end the archive.
  blocks.push(new Uint8Array(BLOCK * 2));

  const archive = new Uint8Array(blocks.reduce((total, block) => total + block.length, 0));

  let at = 0;

  for (const block of blocks) {
    archive.set(block, at);

    at += block.length;
  }

  return archive;
}

function buildHeader(path: string, size: number, mode: number): Uint8Array {
  const encoder = new TextEncoder();

  const split = splitArchivePath(path);

  const header = new Uint8Array(BLOCK);

  header.set(encoder.encode(split.name), 0);
  header.set(encoder.encode(formatOctal(mode, 8)), 100);
  header.set(encoder.encode(formatOctal(0, 8)), 108);
  header.set(encoder.encode(formatOctal(0, 8)), 116);
  header.set(encoder.encode(formatOctal(size, 12)), 124);
  header.set(encoder.encode(formatOctal(0, 12)), 136);

  // The checksum counts its own field as spaces.
  header.set(encoder.encode('        '), 148);

  header[156] = '0'.codePointAt(0) ?? 0;

  header.set(encoder.encode('ustar\u000000'), 257);
  header.set(encoder.encode(split.prefix), 345);

  const checksum = header.reduce((total, byte) => total + byte, 0);

  header.set(encoder.encode(`${checksum.toString(8).padStart(6, '0')}\u0000 `), 148);

  return header;
}

const NAME_BYTES = 100;
const PREFIX_BYTES = 155;

// The ustar fields a path fills: the whole path as the name when it fits,
// otherwise the part before the last slash that leaves a name short enough,
// with that slash dropped, as the prefix.
function splitArchivePath(path: string): { readonly prefix: string; readonly name: string } {
  if (countBytes(path) <= NAME_BYTES) {
    return { prefix: '', name: path };
  }

  for (let at = path.indexOf('/'); at !== -1; at = path.indexOf('/', at + 1)) {
    const prefix = path.slice(0, at);
    const name = path.slice(at + 1);

    if (countBytes(prefix) <= PREFIX_BYTES && countBytes(name) <= NAME_BYTES && name !== '') {
      return { prefix, name };
    }
  }

  throw new Error(`archive path does not fit a ustar header: ${path}`);
}

function countBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

// An octal number padded to fill its field, ending in a NUL.
function formatOctal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\u0000`;
}
