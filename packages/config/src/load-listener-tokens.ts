import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import invariant from 'tiny-invariant';

// The fewest bytes a listener token may hold.
const MIN_TOKEN_BYTES = 32;

type LoadedListenerTokens =
  | { readonly ok: true; readonly tokens: readonly string[] }
  | { readonly ok: false; readonly reason: string };

type OwnerOnlyRead =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: string };

// A token file other users can open would let any of them act as the
// listener's clients, so only a file the process's own user owns, with no
// group or other bits, loads.
export function loadListenerTokens(path: string): LoadedListenerTokens {
  let read: OwnerOnlyRead;

  try {
    read = readOwnerOnlyFile(path);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    return { ok: false, reason: `cannot read ${path}: ${detail}` };
  }

  if (!read.ok) {
    return read;
  }

  const text = read.text;
  const lines = (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
  const tokens = lines.map((line) => line.trim());

  if (tokens.some((token) => Buffer.byteLength(token) < MIN_TOKEN_BYTES)) {
    return {
      ok: false,
      reason: `${path} holds a token under ${MIN_TOKEN_BYTES} bytes or a blank line`,
    };
  }

  if (tokens.length > 2) {
    return {
      ok: false,
      reason: `${path} holds ${tokens.length} lines; it takes one or two tokens`,
    };
  }

  return { ok: true, tokens };
}

// The permission bits that let the owner's group or any other user at a file.
const SHARED_MODE_BITS = 0o077;

// The file is checked through the descriptor it is read from, so a swap of
// the path between the check and the read changes nothing.
function readOwnerOnlyFile(path: string): OwnerOnlyRead {
  const descriptor = openSync(path, 'r');

  try {
    const stats = fstatSync(descriptor);

    invariant(process.getuid, 'atc runs only where processes have user ids');

    if (stats.uid !== process.getuid()) {
      return {
        ok: false,
        reason: `${path} belongs to another user; give it to this user, then run chmod 600 ${path}`,
      };
    }

    if ((stats.mode & SHARED_MODE_BITS) !== 0) {
      return {
        ok: false,
        reason: `other users can open ${path} (mode ${(stats.mode & 0o777).toString(8)}); run chmod 600 ${path}`,
      };
    }

    return { ok: true, text: readFileSync(descriptor, 'utf8') };
  } finally {
    closeSync(descriptor);
  }
}
