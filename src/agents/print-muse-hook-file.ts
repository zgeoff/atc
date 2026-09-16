import { buildCLICommand } from './build-cli-command';

const MUSE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PermissionRequest',
  'Notification',
  'Stop',
  'SessionEnd',
] as const;

/**
 * Print the Muse hook entries to stdout. The operator merges them into the
 * `hooks` block of `$XDG_CONFIG_HOME/muse/settings.json`; atc never writes
 * that path. Muse has no `--settings` equivalent, so unlike Claude the
 * instrumentation cannot be handed over per spawn.
 */
export function printMuseHookFile(): void {
  process.stdout.write(buildMuseHookFile());
}

function buildMuseHookFile(): string {
  const cmd = buildCLICommand('hook-report');
  const entry = [{ matcher: '', hooks: [{ type: 'command', command: cmd, timeout_ms: 5000 }] }];
  const hooks = Object.fromEntries(MUSE_HOOK_EVENTS.map((event) => [event, entry]));

  return `${JSON.stringify({ hooks }, null, 2)}\n`;
}
