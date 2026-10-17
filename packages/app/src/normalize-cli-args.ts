export function normalizeCLIArgs(args: readonly string[]): string[] {
  const normalized: string[] = [];
  const [first] = args;

  if (first === '--daemon' || first?.startsWith('--daemon=') === true) {
    // the parser hands flags to a default subcommand only when the first
    // argument is not a subcommand's name
    normalized.push('tui');
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--') {
      normalized.push(...args.slice(i));
      break;
    }

    // a grant id can start with a dash, which the parser reads as short flags
    // and crashes on; inline, it stays the option's value
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
