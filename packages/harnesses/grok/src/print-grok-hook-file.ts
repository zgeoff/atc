import { buildHookCommand, buildHookEntry } from '@atc/plugin-api';
import { GROK_HOOKS } from './grok-hooks';

/**
 * Print the Grok hook file to stdout. The operator copies it to
 * `$GROK_HOME/hooks/atc-reporter.json`; atc never writes that path. Each
 * hook runs atc through `atcArgv`. `write` takes the printed text, stdout by
 * default.
 */
export function printGrokHookFile(
  atcArgv: readonly string[],
  write: (text: string) => void = (text) => {
    process.stdout.write(text);
  },
): void {
  write(buildGrokHookFile(atcArgv));
}

function buildGrokHookFile(atcArgv: readonly string[]): string {
  const cmd = buildHookCommand('hook-report --agent grok', atcArgv);
  const hooks = Object.fromEntries(GROK_HOOKS.map((event) => [event, [buildHookEntry(cmd, 5)]]));

  return `${JSON.stringify({ hooks }, null, 2)}\n`;
}
