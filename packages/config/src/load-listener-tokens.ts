import { readOwnerOnlyText } from './read-owner-only-file';
import type { TokenFileAccess } from './read-owner-only-file';

// The fewest bytes a listener token may hold.
const MIN_TOKEN_BYTES = 32;

type LoadedListenerTokens =
  | { readonly ok: true; readonly tokens: readonly string[] }
  | { readonly ok: false; readonly reason: string };

export function loadListenerTokens(path: string, access: TokenFileAccess): LoadedListenerTokens {
  const read = readOwnerOnlyText(path, access);

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
