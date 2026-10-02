/**
 * The value a CLI flag takes in an argument list, written either as the flag
 * followed by its value or as `--flag=value`. The last occurrence wins, as it
 * does for the CLIs atc runs; null when the list never sets the flag.
 */
export function findFlagValue(args: readonly string[], names: readonly string[]): string | null {
  let value: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    const next = args[index + 1];

    if (names.includes(arg) && next !== undefined) {
      value = next;
      index += 1;
      continue;
    }

    const inline = names.find((name) => name.startsWith('--') && arg.startsWith(`${name}=`));

    if (inline !== undefined) {
      value = arg.slice(inline.length + 1);
    }
  }

  return value;
}
