import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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

export interface Config {
  claudeBin: string;
  claudeArgs: string[];
  grokBin: string;
  grokArgs: string[];
  codexBin: string;
  codexArgs: string[];
  gateways: GatewayConfig[];
  leader: LeaderKey;
}

interface LeaderKey {
  readonly code: number;
  readonly label: string;
}

const DEFAULTS: Config = {
  claudeBin: 'claude',
  claudeArgs: [],
  grokBin: 'grok',
  grokArgs: [],
  codexBin: 'codex',
  codexArgs: [],
  gateways: [],
  leader: { code: 0, label: '^Space' },
};

const configDir = join(homedir(), '.config', 'atc');

export const stateDir = join(homedir(), '.local', 'state', 'atc');
export const socketPath = join(process.env['XDG_RUNTIME_DIR'] ?? stateDir, 'atc.sock');
export const daemonSocketPath = join(process.env['XDG_RUNTIME_DIR'] ?? stateDir, 'atc-daemon.sock');
export const statusFile = join(stateDir, 'status.json');
export const dbFile = join(stateDir, 'atc.db');
export const legacyFleetFile = join(stateDir, 'fleet.json');
export const daemonPidFile = join(process.env['XDG_RUNTIME_DIR'] ?? stateDir, 'atc-daemon.pid');

export function loadConfig(): Config {
  mkdirSync(configDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  const file = join(configDir, 'config.json');

  if (!existsSync(file)) {
    writeFileSync(file, `${JSON.stringify(DEFAULTS, null, 2)}\n`);

    return { ...DEFAULTS };
  }

  try {
    const raw = readFileSync(file, 'utf8');
    const parsed: unknown = JSON.parse(raw);

    if (!isRecord(parsed)) {
      return { ...DEFAULTS };
    }

    const claudeBin =
      typeof parsed['claudeBin'] === 'string' ? parsed['claudeBin'] : DEFAULTS.claudeBin;

    const claudeArgs = Array.isArray(parsed['claudeArgs'])
      ? parsed['claudeArgs'].filter((a): a is string => typeof a === 'string')
      : DEFAULTS.claudeArgs;

    const grokBin = typeof parsed['grokBin'] === 'string' ? parsed['grokBin'] : DEFAULTS.grokBin;

    const grokArgs = Array.isArray(parsed['grokArgs'])
      ? parsed['grokArgs'].filter((a): a is string => typeof a === 'string')
      : DEFAULTS.grokArgs;

    const codexBin =
      typeof parsed['codexBin'] === 'string' ? parsed['codexBin'] : DEFAULTS.codexBin;

    const codexArgs = Array.isArray(parsed['codexArgs'])
      ? parsed['codexArgs'].filter((a): a is string => typeof a === 'string')
      : DEFAULTS.codexArgs;

    const gateways = collectGateways(parsed['gateways'], claudeBin, claudeArgs);

    const leader =
      (typeof parsed['leader'] === 'string' ? decodeLeader(parsed['leader']) : null) ??
      DEFAULTS.leader;

    return { claudeBin, claudeArgs, grokBin, grokArgs, codexBin, codexArgs, gateways, leader };
  } catch {
    return { ...DEFAULTS };
  }
}

// Ids the built-in adapters answer to; a gateway may not take one.
const BUILT_IN_IDS = new Set(['claude', 'grok', 'codex']);

/**
 * Reads the gateway map into menu order. An entry without a base URL, or
 * under an id another adapter already answers to, is left out rather than
 * registered half-formed: every gateway in the result can be spawned.
 */
function collectGateways(
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

// Control bytes the terminal needs for its own input: enter, tab, and esc
// as leaders would swallow ordinary typing.
const RESERVED_CODES = new Set([0x09, 0x0d, 0x1b]);

/**
 * Decodes a leader name like "ctrl-space", "ctrl-]", or "ctrl-a" into its
 * control byte and status-bar label. Unknown or reserved keys decode to
 * null, so a bad config falls back to the default instead of breaking the
 * client.
 */
function decodeLeader(name: string): LeaderKey | null {
  const m = /^ctrl-(?<key>.+)$/i.exec(name.trim().toLowerCase());
  const key = m?.groups?.['key'];

  if (key === undefined) {
    return null;
  }

  if (key === 'space') {
    return { code: 0, label: '^Space' };
  }

  let code: number | null = null;
  const cp = key.codePointAt(0);

  if (/^[a-z]$/.test(key) && cp !== undefined) {
    code = cp - 96;
  } else if (key === '[') {
    code = 0x1b;
  } else if (key === '\\') {
    code = 0x1c;
  } else if (key === ']') {
    code = 0x1d;
  } else if (key === '^') {
    code = 0x1e;
  } else if (key === '_') {
    code = 0x1f;
  }

  if (code === null || RESERVED_CODES.has(code)) {
    return null;
  }

  return { code, label: `^${key.toUpperCase()}` };
}
