import { buildHookCommand, buildHookEntry } from '@atc/plugin-api';
import { GROK_HOOKS } from './grok-hooks';

// the operator copies this to `$GROK_HOME/hooks/atc-reporter.json`; atc never writes that path
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
