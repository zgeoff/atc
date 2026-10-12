/**
 * Holds each environment variable a test has overridden, keyed by name, with
 * the value it held before its first override in that test; `undefined`
 * records a variable that was unset.
 */
export const envOriginals = new Map<string, string | undefined>();
