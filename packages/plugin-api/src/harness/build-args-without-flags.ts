export function buildArgsWithoutFlags(args: readonly string[], names: readonly string[]): string[] {
  const kept: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';

    if (names.includes(arg)) {
      index += 1;
      continue;
    }

    if (names.some((name) => name.startsWith('--') && arg.startsWith(`${name}=`))) {
      continue;
    }

    kept.push(arg);
  }

  return kept;
}
