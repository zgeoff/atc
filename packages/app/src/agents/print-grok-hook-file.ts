import { buildHookCommand } from '@atc/plugin-api/harness/build-hook-command';
import { buildCLIArgv } from './build-cli-argv';

const GROK_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'Stop',
  'StopFailure',
  'StopCancelled',
  'Notification',
] as const;

/**
 * Print the Grok hook file to stdout. The operator copies it to
 * `$GROK_HOME/hooks/atc-reporter.json`; atc never writes that path. `write`
 * takes the printed text, stdout by default.
 */
export function printGrokHookFile(
  write: (text: string) => void = (text) => {
    process.stdout.write(text);
  },
): void {
  write(buildGrokHookFile());
}

function buildGrokHookFile(): string {
  const cmd = buildHookCommand('hook-report --agent grok', buildCLIArgv());
  const entry = [{ hooks: [{ type: 'command', command: cmd, timeout: 5 }] }];
  const hooks = Object.fromEntries(GROK_HOOK_EVENTS.map((event) => [event, entry]));

  return `${JSON.stringify({ hooks }, null, 2)}\n`;
}
