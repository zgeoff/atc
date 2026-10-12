import { buildHookCommand } from '@atc/plugin-api/harness/build-hook-command';
import { buildHookEntry } from '@atc/plugin-api/harness/build-hook-entry';

const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PermissionRequest',
  'Stop',
] as const;

/**
 * The Codex hook file whose entries report each hook event to atc under
 * the codex agent, run through `argv`: the atc of the daemon's machine, or
 * the atc inside a remote host.
 */
export function buildCodexHookFile(argv: readonly string[]): string {
  const cmd = buildHookCommand('hook-report --agent codex', argv);

  const hooks = Object.fromEntries(
    CODEX_HOOK_EVENTS.map((event) => [event, [buildHookEntry(cmd, 5)]]),
  );

  // Codex caps SessionEnd hooks at three seconds.
  const file = { hooks: { ...hooks, SessionEnd: [buildHookEntry(cmd, 3)] } };

  return `${JSON.stringify(file, null, 2)}\n`;
}
