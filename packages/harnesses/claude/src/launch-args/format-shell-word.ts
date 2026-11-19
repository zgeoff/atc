import { toShellArg } from '@atc/core';

// A binary name or path that needs no quoting stays bare, so the default
// entry resumes with plain `claude`; anything else is quoted as one word.
export function formatShellWord(value: string): string {
  return /^[\w./-]+$/u.test(value) ? value : toShellArg(value);
}
