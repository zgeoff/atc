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
 * its parent directories created on the way. A path longer than ustar
 * holds is refused.
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

  const name = encoder.encode(path);

  if (name.length > 100) {
    throw new Error(`archive path is longer than 100 bytes: ${path}`);
  }

  const header = new Uint8Array(BLOCK);

  header.set(name, 0);
  header.set(encoder.encode(formatOctal(mode, 8)), 100);
  header.set(encoder.encode(formatOctal(0, 8)), 108);
  header.set(encoder.encode(formatOctal(0, 8)), 116);
  header.set(encoder.encode(formatOctal(size, 12)), 124);
  header.set(encoder.encode(formatOctal(0, 12)), 136);

  // The checksum counts its own field as spaces.
  header.set(encoder.encode('        '), 148);

  header[156] = '0'.codePointAt(0) ?? 0;

  header.set(encoder.encode('ustar\u000000'), 257);

  const checksum = header.reduce((total, byte) => total + byte, 0);

  header.set(encoder.encode(`${checksum.toString(8).padStart(6, '0')}\u0000 `), 148);

  return header;
}

// An octal number padded to fill its field, ending in a NUL.
function formatOctal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\u0000`;
}
