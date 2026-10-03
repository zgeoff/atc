/**
 * An argument list with every occurrence of the named flags removed, each
 * with its value: the flag followed by its value, or `--flag=value`. Every
 * other argument keeps its place.
 */
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
