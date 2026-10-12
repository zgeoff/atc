/**
 * Matches any C0 control character or DEL, which a value that reaches a
 * command line or a path is refused for.
 */
// oxlint-disable-next-line no-control-regex -- control characters are what the pattern matches
export const CONTROL_CHARACTER = /[\u0000-\u001F\u007F]/u;
