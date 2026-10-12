/**
 * Joins `--revoke <value>` into `--revoke=<value>` before the argument
 * parser sees it. A grant id can start with a dash, and the parser reads a
 * separate dash-led value as a group of short flags; an underscore among
 * them overwrites its positional list and crashes it. Inline, the value
 * stays the option's whatever it starts with.
 */
export function normalizeCLIArgs(args: readonly string[]): string[] {
  const normalized: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--') {
      normalized.push(...args.slice(i));
      break;
    }

    if (arg === '--revoke' && next !== undefined) {
      normalized.push(`--revoke=${next}`);

      i++;
      continue;
    }

    if (arg !== undefined) {
      normalized.push(arg);
    }
  }

  return normalized;
}
