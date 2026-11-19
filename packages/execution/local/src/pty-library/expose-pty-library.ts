import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pickPTYLibrary } from './pick-pty-library';
import { writePTYLibrary } from './write-pty-library';

let previous: string | undefined;

// Bun 1.4.4 copies an embedded library into TMPDIR on its first dlopen under a scratch name
// built from the wall clock and a per-process counter, so if two processes read one clock
// time, one of them fails to load the library.
export function exposePTYLibrary(): void {
  previous = process.env['BUN_PTY_LIB'];

  const library = pickPTYLibrary(Bun.embeddedFiles, probeMusl());

  if (library === null) {
    return;
  }

  // An embedded Blob reads only asynchronously, and a compiled binary keeps
  // its embedded files beside the bundle.
  const bytes = readFileSync(join(import.meta.dir, library));

  writePTYLibrary(process.env, { name: library, bytes }, tmpdir());
}

// Harnesses start with the daemon's environment, and a bun-pty of another
// version in a session must not load this copy.
export function restorePTYLibraryEnv(): void {
  if (previous === undefined) {
    Reflect.deleteProperty(process.env, 'BUN_PTY_LIB');
  } else {
    process.env['BUN_PTY_LIB'] = previous;
  }
}

// bun-pty loads its musl library when the process maps the musl loader.
function probeMusl(): boolean {
  if (process.platform !== 'linux') {
    return false;
  }

  try {
    return readFileSync('/proc/self/maps', 'utf8').includes('ld-musl');
  } catch {
    return false;
  }
}
