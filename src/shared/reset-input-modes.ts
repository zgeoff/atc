/**
 * Returns the terminal's input handling to its unenhanced defaults: pops the
 * kitty keyboard protocol, clears modifyOtherKeys, and turns off every mode
 * that changes key encoding or injects reports into stdin (mouse tracking,
 * SGR mouse encoding, alternate scroll, focus events, bracketed paste, and
 * color-scheme reports). Written when a session's screen is replaced by a
 * chrome screen or the outer shell, so a session's input modes never leak
 * past its own screen; a replay re-applies whatever the session had set.
 */
export const RESET_INPUT_MODES =
  '\u001B[<u\u001B[>4;0m\u001B[?1000l\u001B[?1002l\u001B[?1003l\u001B[?1006l\u001B[?1007l\u001B[?1004l\u001B[?2004l\u001B[?2031l';
