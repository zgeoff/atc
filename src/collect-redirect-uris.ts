/**
 * Every `--redirect-uri` value in a command line, in order, whether given as
 * `--redirect-uri <uri>` or `--redirect-uri=<uri>`. The flag can repeat, and
 * the argument parser keeps only its last value.
 */
export function collectRedirectURIs(rawArgs: readonly string[]): readonly string[] {
  return rawArgs.flatMap((arg, index) => {
    if (arg.startsWith('--redirect-uri=')) {
      return [arg.slice('--redirect-uri='.length)];
    }

    const next = rawArgs[index + 1];

    return arg === '--redirect-uri' && next !== undefined ? [next] : [];
  });
}
