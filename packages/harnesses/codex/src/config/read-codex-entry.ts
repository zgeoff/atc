import type { AgentEntry, AgentEntryRead } from '@atc/config';
import {
  collectProfileEnvProblems,
  collectSignInOverrideProblems,
  collectTelemetryEnvProblems,
} from '@atc/config';
import { isBrokerVariable } from '@atc/core';
import type { AuthProfile } from '@atc/plugin-api';
import { CODEX_CREDENTIAL_VARIABLES } from './codex-credential-variables';
import { collectCodexAuth } from './collect-codex-auth';

interface CodexEntryArgs {
  readonly entry: AgentEntry;
  readonly raw: Readonly<Record<string, unknown>>;
  readonly authProfiles: ReadonlyMap<string, AuthProfile>;
}

export function readCodexEntry(args: CodexEntryArgs): AgentEntryRead {
  const entry = args.entry;
  const raw = args.raw['auth'];

  if (raw === undefined) {
    return { entry, warnings: [] };
  }

  const collected = collectCodexAuth(raw, args.authProfiles);
  const envKeys = Object.keys(entry.env);
  const problems = collectSignInOverrideProblems([['env', envKeys]], isCodexSignInOverrideVariable);

  if (collected.profiles === null) {
    return { problems: [...collected.errors, ...problems] };
  }

  problems.push(
    ...collectProfileEnvProblems([['env', envKeys]], collected.envOwners),
    ...collectTelemetryEnvProblems([['env', envKeys]], collected.telemetry),
  );

  if (problems.length > 0) {
    return { problems };
  }

  return {
    entry: { ...entry, auth: { profiles: collected.profiles, placeholderEnv: {} } },
    warnings: [],
  };
}

function isCodexSignInOverrideVariable(key: string): boolean {
  return CODEX_CREDENTIAL_VARIABLES.includes(key) || isBrokerVariable(key);
}
