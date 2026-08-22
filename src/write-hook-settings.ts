import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentID } from './agent-adapter';
import { buildCLICommand } from './build-cli-command';
import { stateDir } from './config';
import { isRecord } from './report';

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
 * Writes the settings file injected into wrangled sessions via
 * `claude --settings`, one per agent id. The user's own settings are
 * untouched; these hooks only exist in sessions atc spawns, and identify
 * themselves via ATC_SESSION_ID in the env.
 */
export function writeHookSettings(profile: HookSettingsProfile): string {
  const cmd = buildCLICommand('hook-report');
  const entry = [{ hooks: [{ type: 'command', command: cmd, timeout: 5 }] }];

  const settings = {
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
  };

  // Fleet status renders inside Claude Code's own status line; the injected
  // command chains the user's configured statusline first, so mirror their
  // padding.
  let padding = 0;

  try {
    const settingsPath = join(homedir(), '.claude', 'settings.json');
    const raw = readFileSync(settingsPath, 'utf8');
    const user: unknown = JSON.parse(raw);
    const statusLine = isRecord(user) ? user['statusLine'] : undefined;
    const userPadding = isRecord(statusLine) ? statusLine['padding'] : undefined;

    if (typeof userPadding === 'number') {
      padding = userPadding;
    }
  } catch {}

  const statusline = {
    type: 'command',
    command: buildCLICommand('statusline'),
    padding,
  };

  const file = join(stateDir, `hook-settings-${profile.id}.json`);

  // A settings-file env block outranks a shell export of the same variable,
  // so a session's backend is decided here rather than by whatever the
  // terminal happened to carry. The credential is never written: the helper
  // command supplies it at run time.
  writeFileSync(
    file,
    JSON.stringify(
      {
        ...settings,
        statusLine: statusline,
        ...(profile.env === undefined || Object.keys(profile.env).length === 0
          ? {}
          : { env: profile.env }),
        ...(profile.apiKeyHelper === undefined ? {} : { apiKeyHelper: profile.apiKeyHelper }),
      },
      null,
      2,
    ),
  );

  return file;
}
