import { z } from 'zod';
import type { AgentID } from './agent-adapter';
import { buildCLICommand } from './build-cli-command';

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
 * only exist in sessions atc spawns, and identify themselves via
 * ATC_SESSION_ID in the env.
 *
 * A settings-file env block outranks a shell export of the same variable, so
 * a session's backend is decided here rather than by whatever the terminal
 * happened to carry. The credential is never part of it: the helper command
 * supplies that at run time, so it never reaches a file atc writes.
 */
export function buildHookSettings(
  profile: HookSettingsProfile,
  statuslinePadding: number,
): Record<string, unknown> {
  const entry = [
    { hooks: [{ type: 'command', command: buildCLICommand('hook-report'), timeout: 5 }] },
  ];

  const own = {
    hooks: mergeSessionHooks(
      {
        // SessionStart carries the session id at spawn/resume time, before any
        // interaction — without it a session only enters the fleet file after
        // its first prompt/notification.
        SessionStart: entry,
        Notification: entry,
        Stop: entry,
        UserPromptSubmit: entry,
        SessionEnd: entry,
      },
      profile.settings?.['hooks'],
    ),

    // Fleet status renders inside Claude Code's own status line; the injected
    // command chains the user's configured statusline first, so mirror their
    // padding.
    statusLine: {
      type: 'command',
      command: buildCLICommand('statusline'),
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
