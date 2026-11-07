import { toShellArg } from '@atc/core';

// A binary name or path that needs no quoting stays bare, so a default
// entry resumes with its plain binary name; anything else is quoted as one
// word.
export function formatShellWord(value: string): string {
  return /^[\w./-]+$/u.test(value) ? value : toShellArg(value);
}
