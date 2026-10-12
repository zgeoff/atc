export interface DaemonFlags {
  readonly listen: string | null;
  readonly tokenFile: string | null;
}

/**
 * The `--listen` and `--token-file` values among a daemon's command-line
 * arguments. Both the `--flag value` and `--flag=value` forms count; a flag
 * the line lacks reads as null.
 */
export function parseDaemonFlags(args: readonly string[]): DaemonFlags {
  return {
    listen: findFlagValue(args, '--listen'),
    tokenFile: findFlagValue(args, '--token-file'),
  };
}

function findFlagValue(args: readonly string[], flag: string): string | null {
  for (const [i, arg] of args.entries()) {
    if (arg === flag) {
      return args[i + 1] ?? null;
    }

    if (arg.startsWith(`${flag}=`)) {
      return arg.slice(flag.length + 1);
    }
  }

  return null;
}
