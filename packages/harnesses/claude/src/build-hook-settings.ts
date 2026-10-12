import type { AgentID } from '@atc/core/agent-id';
import { toShellArg } from '@atc/core/to-shell-arg';
import { buildHookCommand } from '@atc/plugin-api/harness/build-hook-command';
import { buildHookEntry } from '@atc/plugin-api/harness/build-hook-entry';
import { z } from 'zod';
import { CLAUDE_HOOKS } from './claude-hooks';

/**
 * What one agent id needs on top of the shared instrumentation. The
 * environment block and the credential helper point the CLI at a backend
 * other than the default one; both are absent for the stock agent. The
 * settings are whatever else the config asked this agent's sessions to start
 * with.
 */
export interface HookSettingsProfile {
  readonly id: AgentID;
  readonly env?: Readonly<Record<string, string>>;
  readonly apiKeyHelper?: string;
  readonly settings?: Readonly<Record<string, unknown>>;
}

/**
 * The settings object injected into wrangled sessions via
 * `claude --settings`. The user's own settings are untouched; these hooks
 * only exist in sessions atc spawns, and identify themselves via the
 * session id in their session environment and the agent id on their
 * command line. A nested harness inherits the env but not the command
 * line, so the agent id keeps its reports from passing as the session's
 * own.
 *
 * A settings-file env block outranks a shell export of the same variable, so
 * a session's backend is decided here rather than by whatever the terminal
 * happened to carry. The credential is never part of it: the helper command
 * supplies that at run time, so it never reaches a file atc writes.
 *
 * The hooks run the atc CLI that `cliArgv` runs. A session on a remote host
 * gets the argv of the atc inside that host, whose statusline renders that
 * session's own state alone.
 */
export function buildHookSettings(
  profile: HookSettingsProfile,
  statuslinePadding: number,
  cliArgv: readonly string[],
): Record<string, unknown> {
  const command = buildHookCommand(`hook-report --agent ${toShellArg(profile.id)}`, cliArgv);
  const entry = [buildHookEntry(command, 5)];

  const own = {
    hooks: mergeSessionHooks(
      Object.fromEntries(Object.keys(CLAUDE_HOOKS).map((event) => [event, entry])),
      profile.settings?.['hooks'],
    ),

    // Fleet status renders inside Claude Code's own status line; the injected
    // command chains the user's configured statusline first, so mirror their
    // padding.
    statusLine: {
      type: 'command',
      command: buildHookCommand(`statusline --agent ${toShellArg(profile.id)}`, cliArgv),
      padding: statuslinePadding,
    },
    ...(profile.env === undefined || Object.keys(profile.env).length === 0
      ? {}
      : { env: profile.env }),
    ...(profile.apiKeyHelper === undefined ? {} : { apiKeyHelper: profile.apiKeyHelper }),
  };

  // The configured settings fill in around what atc writes and never replace
  // it: a session atc did not instrument is a session the fleet cannot track.
  return { ...profile.settings, ...own };
}

type SessionHooks = Readonly<Record<string, readonly unknown[]>>;

// One hook list per event name, which is the shape every harness that reads
// this file takes.
const CONFIGURED_HOOKS_SCHEMA = z.record(z.string(), z.array(z.unknown()));

/**
 * atc's own reporter plus whatever the config added, per event. The reporter
 * runs first and the configured entries follow it, so an added hook joins the
 * fleet's rather than displacing it. A block that is not hook lists is left out
 * whole, and costs its own entries rather than atc's.
 */
function mergeSessionHooks(own: SessionHooks, configured: unknown): SessionHooks {
  const parsed = CONFIGURED_HOOKS_SCHEMA.safeParse(configured);

  if (!parsed.success) {
    return own;
  }

  const merged: Record<string, readonly unknown[]> = { ...own };

  for (const [event, entries] of Object.entries(parsed.data)) {
    merged[event] = [...(merged[event] ?? []), ...entries];
  }

  return merged;
}
