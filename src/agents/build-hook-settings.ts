import type { AgentID } from './agent-adapter';
import { buildCLICommand } from './build-cli-command';

/**
 * What one agent id needs on top of the shared instrumentation. The
 * environment block and the credential helper point the CLI at a backend
 * other than the default one; both are absent for the stock agent.
 */
export interface HookSettingsProfile {
  readonly id: AgentID;
  readonly env?: Readonly<Record<string, string>>;
  readonly apiKeyHelper?: string;
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

  return {
    hooks: {
      // SessionStart carries the session id at spawn/resume time, before any
      // interaction — without it a session only enters the fleet file after
      // its first prompt/notification.
      SessionStart: entry,
      Notification: entry,
      Stop: entry,
      UserPromptSubmit: entry,
      SessionEnd: entry,
    },

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
}
