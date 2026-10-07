import { CString, FFIType, dlopen, read } from 'bun:ffi';
import { readFileSync } from 'node:fs';

/**
 * The names in the daemon process's native environment: the block a
 * native library reads when it starts a child, as opposed to the copy Bun
 * keeps for `process.env`. Changes to `process.env` never reach that
 * block, so it keeps every variable the daemon started with, including
 * ones deleted from `process.env` since.
 *
 * Linux reads the block from `/proc/self/environ`; macOS walks the live
 * `environ` array that `_NSGetEnviron` returns. Any other platform throws,
 * since a harness started without the list could inherit a withheld
 * variable.
 */
export function readNativeEnvKeys(): string[] {
  const keys = new Set<string>();

  for (const entry of readNativeEnvEntries()) {
    const eq = entry.indexOf('=');

    if (eq > 0) {
      keys.add(entry.slice(0, eq));
    }
  }

  return [...keys];
}

function readNativeEnvEntries(): string[] {
  if (process.platform === 'linux') {
    return readFileSync('/proc/self/environ', 'utf8').split('\0');
  }

  if (process.platform === 'darwin') {
    return readDarwinEnviron();
  }

  throw new Error(`atc cannot read the native environment on ${process.platform}`);
}

const POINTER_BYTES = 8;

// `_NSGetEnviron` returns a pointer to `environ`, a NULL-terminated array of
// `NAME=value` C strings.
function readDarwinEnviron(): string[] {
  const libSystem = dlopen('/usr/lib/libSystem.B.dylib', {
    _NSGetEnviron: { args: [], returns: FFIType.ptr },
  });

  try {
    // oxlint-disable-next-line no-underscore-dangle -- the libSystem symbol carries the underscore
    const environ = libSystem.symbols._NSGetEnviron();

    if (environ === null) {
      throw new Error('atc cannot read the native environment: _NSGetEnviron returned NULL');
    }

    const array = read.ptr(environ);
    const entries: string[] = [];

    for (let offset = 0; ; offset += POINTER_BYTES) {
      const entry = read.ptr(array, offset);

      if (entry === 0) {
        return entries;
      }

      entries.push(new CString(entry));
    }
  } finally {
    libSystem.close();
  }
}
