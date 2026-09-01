import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { buildOptionalString } from './build-optional-string';
import { buildOptionalStringArray } from './build-optional-string-array';
import { collectGateways } from './collect-gateways';
import type { GatewayConfig } from './collect-gateways';
import { collectHooks } from './collect-hooks';
import type { HooksConfig } from './collect-hooks';

export interface Config {
  claudeBin: string;
  claudeArgs: string[];
  grokBin: string;
  grokArgs: string[];
  codexBin: string;
  codexArgs: string[];
  gateways: GatewayConfig[];
  hooks: HooksConfig;
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
  hooks: {},
  leader: { code: 0, label: '^Space' },
};

const configDir = join(homedir(), '.config', 'atc');

export const stateDir = join(homedir(), '.local', 'state', 'atc');
export const socketPath = join(process.env['XDG_RUNTIME_DIR'] ?? stateDir, 'atc.sock');
export const daemonSocketPath = join(process.env['XDG_RUNTIME_DIR'] ?? stateDir, 'atc-daemon.sock');
export const eventsSocketPath = join(process.env['XDG_RUNTIME_DIR'] ?? stateDir, 'atc-events.sock');
export const statusFile = join(stateDir, 'status.json');
export const dbFile = join(stateDir, 'atc.db');
export const legacyFleetFile = join(stateDir, 'fleet.json');
export const daemonPidFile = join(process.env['XDG_RUNTIME_DIR'] ?? stateDir, 'atc-daemon.pid');

// A user-written config.json's top-level keys. An absent or wrong-typed
// field parses to undefined rather than failing the file, so a bad config
// falls back to a default instead of refusing to start atc.
const CONFIG_SCHEMA = z.object({
  claudeBin: buildOptionalString(),
  claudeArgs: buildOptionalStringArray(),
  grokBin: buildOptionalString(),
  grokArgs: buildOptionalStringArray(),
  codexBin: buildOptionalString(),
  codexArgs: buildOptionalStringArray(),
  gateways: z.unknown().optional(),
  hooks: z.unknown().optional(),
  leader: buildOptionalString(),
});

export function loadConfig(): Config {
  mkdirSync(configDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  const file = join(configDir, 'config.json');

  if (!existsSync(file)) {
    writeFileSync(file, `${JSON.stringify(DEFAULTS, null, 2)}\n`);

    return { ...DEFAULTS };
  }

  try {
    return parseConfig(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * Parses a user-written config.json's already-decoded JSON value into a
 * Config, applying every default a malformed or absent field falls back to.
 * Total: no shape of `raw` throws, so a hand-edited config never stops atc
 * starting.
 */
export function parseConfig(raw: unknown): Config {
  const parsed = CONFIG_SCHEMA.safeParse(raw);

  if (!parsed.success) {
    return { ...DEFAULTS };
  }

  const claudeBin = parsed.data.claudeBin ?? DEFAULTS.claudeBin;
  const claudeArgs = parsed.data.claudeArgs ?? DEFAULTS.claudeArgs;
  const grokBin = parsed.data.grokBin ?? DEFAULTS.grokBin;
  const grokArgs = parsed.data.grokArgs ?? DEFAULTS.grokArgs;
  const codexBin = parsed.data.codexBin ?? DEFAULTS.codexBin;
  const codexArgs = parsed.data.codexArgs ?? DEFAULTS.codexArgs;
  const gateways = collectGateways(parsed.data.gateways, claudeBin, claudeArgs);
  const hooks = collectHooks(parsed.data.hooks);

  const leader =
    (parsed.data.leader === undefined ? null : decodeLeader(parsed.data.leader)) ?? DEFAULTS.leader;

  return { claudeBin, claudeArgs, grokBin, grokArgs, codexBin, codexArgs, gateways, hooks, leader };
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
