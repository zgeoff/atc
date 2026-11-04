import { randomUUID } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';

interface PTYLibrary {
  readonly name: string;
  readonly bytes: Uint8Array;
}

// On a failure bun-pty loads Bun's own copy, which fails only when it races
// another process's first copy, so a failure here stops nothing.
export function writePTYLibrary(
  env: Record<string, string | undefined>,
  library: PTYLibrary,
  directory: string,
): void {
  const path = join(
    directory,
    `.atc-pty-${process.geteuid?.() ?? 0}-${Bun.hash(library.bytes).toString(16)}${extname(library.name)}`,
  );

  const scratch = `${path}.${randomUUID()}`;

  try {
    writeFileSync(scratch, library.bytes, { flag: 'wx', mode: 0o600 });
    renameSync(scratch, path);
  } catch (error) {
    rmSync(scratch, { force: true });

    console.error(`atc could not copy its PTY library into ${directory}`, error);

    return;
  }

  env['BUN_PTY_LIB'] = path;
}
