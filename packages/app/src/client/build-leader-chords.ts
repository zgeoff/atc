// a fullscreen agent can switch the terminal into the kitty keyboard protocol or xterm's
// modifyOtherKeys mid-session, so the leader matches the bare byte and both chords.
export function buildLeaderChords(code: number): readonly string[] {
  const base = getBaseCodePoint(code);

  return [String.fromCodePoint(code), `\u001B[${base};5u`, `\u001B[27;5;${base}~`];
}

// The enhanced encodings name the unshifted key, not the control byte it
// maps to: ctrl-space carries space, ctrl-a through ctrl-z carry the
// lowercase letter, and the punctuation controls carry their symbol.
function getBaseCodePoint(code: number): number {
  if (code === 0) {
    return 32;
  }

  if (code <= 26) {
    return code + 96;
  }

  return code + 64;
}
