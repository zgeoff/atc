import { readFileSync } from 'node:fs';

// The fewest bytes a listener token may hold.
const MIN_TOKEN_BYTES = 32;

type LoadedListenerTokens =
  | { readonly ok: true; readonly tokens: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Reads the TCP listener's token file: one or two tokens, one per line,
 * each at least 32 bytes once surrounding whitespace is trimmed. A final
 * newline is allowed. An unreadable file, an empty one, a blank line, a
 * third token, or a short token makes the whole file invalid, so a broken
 * file never leaves part of it working.
 */
export function loadListenerTokens(path: string): LoadedListenerTokens {
  let text: string;

  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    return { ok: false, reason: `cannot read ${path}: ${detail}` };
  }

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
