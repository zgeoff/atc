import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { collectGateways } from './collect-gateways';
import type { GatewayConfig } from './collect-gateways';
import { isRecord } from './report';

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
