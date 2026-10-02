import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { buildOptionalString } from './build-optional-string';
import { buildOptionalStringArray } from './build-optional-string-array';
import { collectDirRoots } from './collect-dir-roots';
import { collectGateways } from './collect-gateways';
import type { GatewayConfig } from './collect-gateways';
import { collectHooks } from './collect-hooks';
import type { HooksConfig } from './collect-hooks';
import { collectPrincipals } from './collect-principals';
import { collectTargets } from './collect-targets';
import type { TargetConfig, TargetConfigError } from './collect-targets';
import { formatJSONKind } from './format-json-kind';
import { isRecord } from './report';
import { resolveHomeDir } from './resolve-home-dir';

export interface Config {
  claudeBin: string;
  claudeArgs: string[];
  grokBin: string;
  grokArgs: string[];
  codexBin: string;
  codexArgs: string[];
  dirs: DirsConfig;
  gateways: GatewayConfig[];
  hooks: HooksConfig;
  leader: LeaderKey;

  // Where sessions run, and the one a spawn without a target runs on: null
  // when the config gives none it can use.
  targets: readonly TargetConfig[];
  defaultTarget: string | null;

  // The target config problems that leave a target, or every target,
  // unusable.
  targetErrors: readonly TargetConfigError[];

  // The targets each principal may use: null when the config has no
  // principals, which leaves every principal the implicit local target.
  principals: ReadonlyMap<string, readonly string[]> | null;
  principalErrors: readonly string[];
}

/**
 * Where the spawn picker looks for directories beyond its own history: each
 * root contributes its child directories and their worktrees.
 */
interface DirsConfig {
  readonly roots: readonly string[];
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
  dirs: { roots: [] },
  gateways: [],
  hooks: {},
  leader: { code: 0, label: '^Space' },
  targets: [{ id: 'local', provider: 'local-pty', options: {} }],
  defaultTarget: 'local',
  targetErrors: [],
  principals: null,
  principalErrors: [],
};

const configDir = join(resolveHomeDir(), '.config', 'atc');

export const configFile = join(configDir, 'config.json');
export const stateDir = join(resolveHomeDir(), '.local', 'state', 'atc');
export const socketPath = join(process.env['XDG_RUNTIME_DIR'] ?? stateDir, 'atc.sock');
export const daemonSocketPath = join(process.env['XDG_RUNTIME_DIR'] ?? stateDir, 'atc-daemon.sock');
export const eventsSocketPath = join(process.env['XDG_RUNTIME_DIR'] ?? stateDir, 'atc-events.sock');
export const statusFile = join(stateDir, 'status.json');
export const dbFile = join(stateDir, 'atc.db');
export const mcpAuthDBFile = join(stateDir, 'mcp-auth.db');
export const legacyFleetFile = join(stateDir, 'fleet.json');
export const daemonPidFile = join(process.env['XDG_RUNTIME_DIR'] ?? stateDir, 'atc-daemon.pid');

// Written by the running daemon: its pid and the socket paths it listens
// on, for a client whose environment computes other socket paths.
export const daemonRecordFile = join(stateDir, 'daemon.json');

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
  dirs: z.unknown().optional(),
  gateways: z.unknown().optional(),
  hooks: z.unknown().optional(),
  leader: buildOptionalString(),
  targets: z.unknown().optional(),
  defaultTarget: z.unknown().optional(),
  principals: z.unknown().optional(),
});

/**
 * Reads and parses config.json. Only an absent file means every default,
 * the implicit `local` target included, and a first run writes those
 * defaults out. A file that exists but cannot be read or parsed loads as
 * unusable: every default but the targets, which it leaves empty with the
 * problem as the one target error, so nothing runs until the file is fixed.
 * Never throws.
 */
export function loadConfig(file: string = configFile): Config {
  // Every atc process writes under the state directory; a failure here
  // comes back from the first write into it.
  try {
    mkdirSync(stateDir, { recursive: true });
  } catch {}

  let text: string;

  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    const code: unknown = error instanceof Error ? Reflect.get(error, 'code') : undefined;

    if (code !== 'ENOENT') {
      const detail = typeof code === 'string' ? code : 'the file could not be read';

      return buildUnusableConfig('config_unreadable', file, detail);
    }

    tryWriteDefaultConfig(file);

    return { ...DEFAULTS };
  }

  let raw: unknown;

  try {
    raw = JSON.parse(text);
  } catch {
    // The parser's own message can quote the file's text, so the detail is
    // a fixed phrase instead.
    return buildUnusableConfig('config_malformed', file, 'the file is not valid JSON');
  }

  return parseConfig(raw, file);
}

/**
 * A config for a file that exists but cannot be used: every default but the
 * targets, which are empty, with no default target and the file's problem
 * as the one target error.
 */
function buildUnusableConfig(
  problem: 'config_malformed' | 'config_unreadable',
  path: string,
  detail: string,
): Config {
  return {
    ...DEFAULTS,
    targets: [],
    defaultTarget: null,
    targetErrors: [{ scope: 'config', problem, path, detail }],
  };
}

/**
 * Writes the first-run config, never over a file that appeared since the
 * read. A failure leaves the defaults in effect for this run, so it is not
 * an error.
 */
function tryWriteDefaultConfig(file: string): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, renderDefaultConfig(), { flag: 'wx' });
  } catch {}
}

/**
 * The config.json text a first run writes. It leaves out the targets and
 * principals, so the file holds the one implicit `local` target and no
 * principals until the user sets their own, and the errors a parse
 * reports, which belong to no file.
 */
export function renderDefaultConfig(): string {
  const {
    targets: _targets,
    defaultTarget: _default,
    targetErrors: _errors,
    principals: _principals,
    principalErrors: _principalErrors,
    ...written
  } = DEFAULTS;

  return `${JSON.stringify(written, null, 2)}\n`;
}

/**
 * Parses a user-written config.json's already-decoded JSON value into a
 * Config, applying every default a malformed or absent field falls back to.
 * A root that is not an object leaves the config unusable, with no targets,
 * and `file` is the path its error holds. Total: no shape of `raw` throws,
 * so a hand-edited config never stops atc starting.
 */
export function parseConfig(raw: unknown, file: string = configFile): Config {
  if (!isRecord(raw) || Array.isArray(raw)) {
    return buildUnusableConfig(
      'config_malformed',
      file,
      `the root is ${formatJSONKind(raw)}, not an object`,
    );
  }

  const parsed = CONFIG_SCHEMA.safeParse(raw);

  if (!parsed.success) {
    return buildUnusableConfig(
      'config_malformed',
      file,
      'the file does not match the config schema',
    );
  }

  const claudeBin = parsed.data.claudeBin ?? DEFAULTS.claudeBin;
  const claudeArgs = parsed.data.claudeArgs ?? DEFAULTS.claudeArgs;
  const grokBin = parsed.data.grokBin ?? DEFAULTS.grokBin;
  const grokArgs = parsed.data.grokArgs ?? DEFAULTS.grokArgs;
  const codexBin = parsed.data.codexBin ?? DEFAULTS.codexBin;
  const codexArgs = parsed.data.codexArgs ?? DEFAULTS.codexArgs;
  const dirs = { roots: collectDirRoots(parsed.data.dirs) };
  const gateways = collectGateways(parsed.data.gateways, claudeBin, claudeArgs);
  const hooks = collectHooks(parsed.data.hooks);
  const targets = collectTargets(parsed.data.targets, parsed.data.defaultTarget);
  const principals = collectPrincipals(parsed.data.principals);

  const leader =
    (parsed.data.leader === undefined ? null : decodeLeader(parsed.data.leader)) ?? DEFAULTS.leader;

  return {
    claudeBin,
    claudeArgs,
    grokBin,
    grokArgs,
    codexBin,
    codexArgs,
    dirs,
    gateways,
    hooks,
    leader,
    targets: targets.targets,
    defaultTarget: targets.defaultTarget,
    targetErrors: targets.errors,
    principals: principals.principals,
    principalErrors: principals.errors,
  };
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
