import type { AgentID } from '@atc/core';
import { toShellArg } from '@atc/core';
import { buildHookCommand, buildHookEntry } from '@atc/plugin-api';
import { z } from 'zod';
import { CLAUDE_HOOKS } from './claude-hooks';

export interface HookSettingsProfile {
  readonly id: AgentID;
  readonly env?: Readonly<Record<string, string>>;
  readonly apiKeyHelper?: string;
  readonly settings?: Readonly<Record<string, unknown>>;
}

export function buildHookSettings(
  profile: HookSettingsProfile,
  statuslinePadding: number,
  cliArgv: readonly string[],
): Record<string, unknown> {
  // the agent id on the command line keeps a nested harness's reports, which inherit the env
  // but not the command line, from passing as the session's own
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

    // a settings-file env block outranks a shell export of the same variable; the credential
    // stays out of it, supplied at run time by the helper command
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

// atc's reporter runs first, so a configured hook joins it rather than displacing it
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
