import { z } from 'zod';
import type { AgentID } from './agent-adapter';
import { isRecord } from './report';

/**
 * A Claude-compatible backend the Claude CLI is pointed at: its own agent id,
 * its own row in the spawn menu, and its own generated settings file. The
 * credential is never held here — a helper command supplies it at run time,
 * so it stays out of the file atc writes.
 */
export interface GatewayConfig {
  readonly id: AgentID;
  readonly label: string;
  readonly mark: string;
  readonly bin: string;
  readonly args: readonly string[];
  readonly baseURL: string;
  readonly apiKeyHelper?: string;
  readonly env: Readonly<Record<string, string>>;
}

// Ids the built-in adapters answer to; a gateway may not take one.
const BUILT_IN_IDS = new Set(['claude', 'grok', 'codex']);

// One gateway map entry's keys. Every field is read once instead of
// indexing the raw entry throughout; an absent or wrong-typed field parses
// to undefined rather than failing the entry, so a malformed gateway is
// left out rather than registered half-formed.
const GATEWAY_ENTRY_SCHEMA = z.object({
  label: buildOptionalNonEmptyString(),
  mark: buildOptionalNonEmptyString(),
  baseURL: buildOptionalNonEmptyString(),
  bin: buildOptionalNonEmptyString(),
  args: buildOptionalStringArray(),
  apiKeyHelper: buildOptionalNonEmptyString(),
  env: buildStringEnvRecord(),
});

/**
 * Reads the gateway map into menu order. An entry without a base URL, or
 * under an id another adapter already answers to, is left out rather than
 * registered half-formed: every gateway in the result can be spawned.
 */
export function collectGateways(
  raw: unknown,
  claudeBin: string,
  claudeArgs: readonly string[],
): GatewayConfig[] {
  if (!isRecord(raw)) {
    return [];
  }

  const gateways: GatewayConfig[] = [];

  for (const [id, entry] of Object.entries(raw)) {
    if (id === '' || BUILT_IN_IDS.has(id)) {
      continue;
    }

    const parsed = GATEWAY_ENTRY_SCHEMA.safeParse(entry);

    if (!parsed.success || parsed.data.baseURL === undefined) {
      continue;
    }

    const firstOfMark = (parsed.data.mark ?? id).codePointAt(0);

    gateways.push({
      id,
      label: parsed.data.label ?? id,

      // oxlint-disable-next-line no-unsafe-type-assertion -- mark falls back to id, and both are checked non-empty above, so codePointAt(0) always returns a code point
      mark: String.fromCodePoint(firstOfMark as number),
      bin: parsed.data.bin ?? claudeBin,
      args: parsed.data.args ?? claudeArgs,
      baseURL: parsed.data.baseURL,
      ...(parsed.data.apiKeyHelper === undefined ? {} : { apiKeyHelper: parsed.data.apiKeyHelper }),
      env: parsed.data.env,
    });
  }

  return gateways;
}

function buildOptionalNonEmptyString() {
  return z.preprocess(
    (v) => (typeof v === 'string' && v !== '' ? v : undefined),
    z.string().optional(),
  );
}

function buildOptionalStringArray() {
  return z.preprocess(
    (v) => (Array.isArray(v) ? v.filter((a): a is string => typeof a === 'string') : undefined),
    z.array(z.string()).optional(),
  );
}

// String values only: everything here is handed to a child process as an
// environment variable.
function buildStringEnvRecord() {
  return z.preprocess(
    (v) => {
      if (!isRecord(v)) {
        return {};
      }

      const env: Record<string, string> = {};

      for (const [key, value] of Object.entries(v)) {
        if (typeof value === 'string') {
          env[key] = value;
        }
      }

      return env;
    },
    z.record(z.string(), z.string()),
  );
}
