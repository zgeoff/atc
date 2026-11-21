// clears modifyOtherKeys, and turns off every mode that changes key encoding or injects reports
// into stdin; it sends no kitty sequence, for a terminal that may lack the protocol
export const RESET_LEGACY_INPUT_MODES =
  '\u001B[>4;0m\u001B[?9l\u001B[?1000l\u001B[?1002l\u001B[?1003l\u001B[?1006l\u001B[?1007l\u001B[?1004l\u001B[?2004l\u001B[?2031l\u001B[?1l\u001B>';

// pops the kitty keyboard protocol as well, so a session's input modes never leak past its own
// screen
export const RESET_INPUT_MODES = `\u001B[<u${RESET_LEGACY_INPUT_MODES}`;
