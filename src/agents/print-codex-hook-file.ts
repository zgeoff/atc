import { buildCLICommand } from './build-cli-command';

const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PermissionRequest',
  'Stop',
] as const;

/**
 * Print the Codex hook entries to stdout. The operator merges them into
 * `$CODEX_HOME/hooks.json` and trusts them once in the Codex TUI — Codex
 * parses untrusted hooks but never runs them. atc never writes that path.
 */
export function printCodexHookFile(): void {
  process.stdout.write(buildCodexHookFile());
}

function buildCodexHookFile(): string {
  const cmd = buildCLICommand('hook-report');
  const buildEntry = (timeout: number) => [{ hooks: [{ type: 'command', command: cmd, timeout }] }];
  const hooks = Object.fromEntries(CODEX_HOOK_EVENTS.map((event) => [event, buildEntry(5)]));

  // Codex caps SessionEnd hooks at three seconds.
  return `${JSON.stringify({ hooks: { ...hooks, SessionEnd: buildEntry(3) } }, null, 2)}\n`;
}
