import type { AgentID } from '@atc/core';
import { isRecord } from '@atc/core';
import type { AuthProfile, GatewayAuth } from '@atc/plugin-api';
import { buildOptionalNonEmptyString, buildOptionalStringArray } from '@atcx/contract/schema';
import { z } from 'zod';
import { checkGatewayAuth } from './check-gateway-auth';

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

  readonly errors: string[];
}

const BUILT_IN_IDS = new Set(['claude', 'grok', 'codex']);

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

function buildOptionalSettings() {
  return z.preprocess(
    (input) => (isRecord(input) ? input : undefined),
    z.record(z.string(), z.unknown()).optional(),
  );
}
