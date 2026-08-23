import { buildCLICommand } from './build-cli-command';

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
 * `$GROK_HOME/hooks/atc-reporter.json`; atc never writes that path.
 */
export function printGrokHookFile(): void {
  process.stdout.write(buildGrokHookFile());
}

function buildGrokHookFile(): string {
  const cmd = buildCLICommand('hook-report');
  const entry = [{ hooks: [{ type: 'command', command: cmd, timeout: 5 }] }];
  const hooks = Object.fromEntries(GROK_HOOK_EVENTS.map((event) => [event, entry]));

  return `${JSON.stringify({ hooks }, null, 2)}\n`;
}
