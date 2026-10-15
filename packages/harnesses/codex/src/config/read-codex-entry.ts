import type { AgentEntry, AgentEntryRead } from '@atc/config';
import type { AuthProfile } from '@atc/plugin-api';
import { collectCodexAuth } from './collect-codex-auth';

interface CodexEntryArgs {
  readonly entry: AgentEntry;
  readonly raw: Readonly<Record<string, unknown>>;
  readonly authProfiles: ReadonlyMap<string, AuthProfile>;
}

/**
 * A Codex entry with the `auth` it holds, or every problem with that auth.
 * Codex takes no placeholder variable: atc writes the sign-in file the CLI
 * reads in place of a credential.
 */
export function readCodexEntry(args: CodexEntryArgs): AgentEntryRead {
  const raw = args.raw['auth'];

  if (raw === undefined) {
    return { entry: args.entry, warnings: [] };
  }

  const collected = collectCodexAuth(raw, args.authProfiles);

  if (collected.profiles === null) {
    return { problems: collected.errors };
  }

  return {
    entry: { ...args.entry, auth: { profiles: collected.profiles, placeholderEnv: {} } },
    warnings: [],
  };
}
