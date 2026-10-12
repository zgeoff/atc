import type { HeadlessRunEvents, HeadlessRunner } from './agent-adapter';
import type { ClaudeHeadlessRunRequest } from './build-claude-query-options';

/**
 * Runs one headless turn through the Claude CLI; the daemon command supplies
 * the Agent SDK implementation, and tests supply a recorder.
 */
export type ClaudeHeadlessRun = (
  opts: ClaudeHeadlessRunRequest,
  hooks: HeadlessRunEvents,
) => { readonly stop: () => void };

/**
 * Where and how a Claude CLI headless turn runs: the binary, the permission
 * mode its adapter resolved, the mod folder, and, for a gateway, the
 * settings file that carries its backend. The folder and file are written
 * on first use.
 */
interface ClaudeHeadlessTarget {
  readonly claudeBin: string;
  readonly permissionMode: string;
  readonly pluginDir: () => string;
  readonly settings?: () => string;
}

/**
 * Turns the Claude CLI's headless run into the neutral runner the daemon
 * calls. Every headless turn runs under the permission mode its adapter
 * resolved for the agent's sessions.
 */
export function makeClaudeHeadlessRunner(
  run: ClaudeHeadlessRun,
  target: ClaudeHeadlessTarget,
): HeadlessRunner {
  return (opts, hooks) =>
    run(
      {
        ...opts,
        claudeBin: target.claudeBin,
        permissionMode: target.permissionMode,
        pluginDir: target.pluginDir(),
        ...(target.settings === undefined ? {} : { settings: target.settings() }),
      },
      hooks,
    );
}
