import type { AgentID } from '@atc/core';
import { isRecord } from '@atc/core';
import { buildOptionalNonEmptyString, buildOptionalStringArray } from '@atc/core/schema';
import type { AuthProfile, GatewayAuth } from '@atc/plugin-api';
import { z } from 'zod';
import { checkGatewayAuth } from './check-gateway-auth';

// the credential never lives here: a helper command supplies it at run time and, with `auth`,
// impd's broker adds it to each request, so it stays out of the file atc writes
export interface GatewayConfig {
  readonly id: AgentID;
  readonly label: string;
  readonly mark: string;
  readonly bin: string;
  readonly args: readonly string[];
  readonly baseURL: string;
  readonly apiKeyHelper?: string;
  readonly env: Readonly<Record<string, string>>;
  readonly settings?: Readonly<Record<string, unknown>>;
  readonly auth?: GatewayAuth;
  readonly pluginDirs?: readonly string[];
}

interface Gateways {
  readonly gateways: GatewayConfig[];

  // The problems that kept a gateway with `auth` out, one per problem.
  readonly errors: string[];
}

// Ids the built-in adapters answer to; a gateway may not take one.
const BUILT_IN_IDS = new Set(['claude', 'grok', 'codex']);

// One gateway map entry's keys. An absent or wrong-typed field parses to
// undefined rather than failing the entry, so a gateway with one bad field
// still registers with the default for it.
const GATEWAY_ENTRY_SCHEMA = z.object({
  label: buildOptionalNonEmptyString(),
  mark: buildOptionalNonEmptyString(),
  baseURL: buildOptionalNonEmptyString(),
  bin: buildOptionalNonEmptyString(),
  args: buildOptionalStringArray(),
  apiKeyHelper: buildOptionalNonEmptyString(),
  env: buildStringEnvRecord(),
  settings: buildOptionalSettings(),
});

// an entry without a base URL or under a taken id is left out rather than registered
// half-formed, so every gateway returned can be spawned
export function collectGateways(
  raw: unknown,
  claudeBin: string,
  claudeArgs: readonly string[],
  authProfiles: ReadonlyMap<string, AuthProfile> = new Map(),
): Gateways {
  if (!isRecord(raw)) {
    return { gateways: [], errors: [] };
  }

  const gateways: GatewayConfig[] = [];
  const errors: string[] = [];

  for (const [id, entry] of Object.entries(raw)) {
    if (id === '' || BUILT_IN_IDS.has(id)) {
      continue;
    }

    const parsed = GATEWAY_ENTRY_SCHEMA.safeParse(entry);

    if (!parsed.success || parsed.data.baseURL === undefined) {
      continue;
    }

    let auth: GatewayAuth | undefined;

    if (isRecord(entry) && entry['auth'] !== undefined) {
      const checked = checkGatewayAuth(entry['auth'], parsed.data, authProfiles);

      if (Array.isArray(checked)) {
        errors.push(...checked.map((problem) => `gateways.${id}: ${problem}`));
        continue;
      }

      auth = checked;
    }

    // the mark's first code point; mark falls back to id, and both are
    // checked non-empty above, so the empty default never applies
    const [firstOfMark = ''] = parsed.data.mark ?? id;

    gateways.push({
      id,
      label: parsed.data.label ?? id,
      mark: firstOfMark,
      bin: parsed.data.bin ?? claudeBin,
      args: parsed.data.args ?? claudeArgs,
      baseURL: parsed.data.baseURL,
      ...(parsed.data.apiKeyHelper === undefined ? {} : { apiKeyHelper: parsed.data.apiKeyHelper }),
      env: parsed.data.env,
      ...(parsed.data.settings === undefined ? {} : { settings: parsed.data.settings }),
      ...(auth === undefined ? {} : { auth }),
    });
  }

  return { gateways, errors };
}

// String values only: everything here is handed to a child process as an
// environment variable.
function buildStringEnvRecord() {
  return z.preprocess(
    (input) => {
      if (!isRecord(input)) {
        return {};
      }

      const env: Record<string, string> = {};

      for (const [key, value] of Object.entries(input)) {
        if (typeof value === 'string') {
          env[key] = value;
        }
      }

      return env;
    },
    z.record(z.string(), z.string()),
  );
}

// Claude Code settings the sessions of this gateway are started with, on top of
// the ones atc writes itself. Anything but an object is no extra settings.
function buildOptionalSettings() {
  return z.preprocess(
    (input) => (isRecord(input) ? input : undefined),
    z.record(z.string(), z.unknown()).optional(),
  );
}
