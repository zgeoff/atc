import { buildCLIArgv } from './build-cli-argv';
import { buildCLICommand } from './build-cli-command';

const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PermissionRequest',
  'Stop',
] as const;

/**
 * The Codex hook file whose entries report each hook event to atc under
 * the codex agent, run through `argv`: the atc of the daemon's machine by
 * default, or the atc inside a remote host.
 */
export function buildCodexHookFile(argv: readonly string[] = buildCLIArgv()): string {
  const cmd = buildCLICommand('hook-report --agent codex', argv);
  const buildEntry = (timeout: number) => [{ hooks: [{ type: 'command', command: cmd, timeout }] }];
  const hooks = Object.fromEntries(CODEX_HOOK_EVENTS.map((event) => [event, buildEntry(5)]));

  // Codex caps SessionEnd hooks at three seconds.
  return `${JSON.stringify({ hooks: { ...hooks, SessionEnd: buildEntry(3) } }, null, 2)}\n`;
}
