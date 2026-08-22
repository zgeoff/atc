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
    if (id === '' || BUILT_IN_IDS.has(id) || gateways.some((g) => g.id === id)) {
      continue;
    }

    if (!isRecord(entry) || typeof entry['baseURL'] !== 'string' || entry['baseURL'] === '') {
      continue;
    }

    const label = typeof entry['label'] === 'string' && entry['label'] !== '' ? entry['label'] : id;
    const mark = typeof entry['mark'] === 'string' && entry['mark'] !== '' ? entry['mark'] : id;
    const firstOfMark = mark.codePointAt(0);
    const apiKeyHelper = entry['apiKeyHelper'];

    gateways.push({
      id,
      label,
      mark: firstOfMark === undefined ? id : String.fromCodePoint(firstOfMark),
      bin: typeof entry['bin'] === 'string' && entry['bin'] !== '' ? entry['bin'] : claudeBin,
      args: Array.isArray(entry['args'])
        ? entry['args'].filter((a): a is string => typeof a === 'string')
        : claudeArgs,
      baseURL: entry['baseURL'],
      ...(typeof apiKeyHelper === 'string' && apiKeyHelper !== '' ? { apiKeyHelper } : {}),
      env: collectGatewayEnv(entry['env']),
    });
  }

  return gateways;
}

// String values only: everything here is handed to a child process as an
// environment variable.
function collectGatewayEnv(raw: unknown): Record<string, string> {
  const env: Record<string, string> = {};

  if (!isRecord(raw)) {
    return env;
  }

  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      env[key] = value;
    }
  }

  return env;
}
