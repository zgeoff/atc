import { toShellArg } from '@atc/core';

export function formatShellWord(value: string): string {
  return /^[\w./-]+$/u.test(value) ? value : toShellArg(value);
}
