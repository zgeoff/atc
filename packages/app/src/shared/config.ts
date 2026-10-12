import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { AgentID } from './agent-id';
import { buildOptionalBoolean } from './build-optional-boolean';
import { buildOptionalString } from './build-optional-string';
import { buildOptionalStringArray } from './build-optional-string-array';
import { collectAgents } from './collect-agents';
import type { AgentEntry } from './collect-agents';
import { collectAuthProfiles } from './collect-auth-profiles';
import type { AuthProfile } from './collect-auth-profiles';
import { collectDirRoots } from './collect-dir-roots';
import { collectHooks } from './collect-hooks';
import type { HooksConfig } from './collect-hooks';
import { collectLegacyAgents } from './collect-legacy-agents';
import { collectPrincipals } from './collect-principals';
import { collectTargets } from './collect-targets';
import type { TargetConfig, TargetConfigError } from './collect-targets';
import { collectWorkspacesConfig } from './collect-workspaces-config';
import type { WorkspacesConfig } from './collect-workspaces-config';
import { DEFAULT_GIT_TRANSPORTS } from './default-git-transports';
import { formatJSONKind } from './format-json-kind';
import { formatMixedAgentKeys } from './format-mixed-agent-keys';
import { LEGACY_AGENT_KEYS } from './legacy-agent-keys';
import { pickDefaultAgent } from './pick-default-agent';
import { REMOVED_CONFIG_KEYS } from './removed-config-keys';
import { isRecord } from './report';
import { resolveHomeDir } from './resolve-home-dir';

export interface Config {
  // The agents atc offers, in menu order, and the problems that left an
  // entry out.
  agents: readonly AgentEntry[];
  agentErrors: readonly string[];

  // The old agent keys a file without `agents` sets, in file order. Empty
  // for a file that uses `agents` or sets none of them.
  legacyAgentKeys: readonly string[];

  // The agent a spawn without one runs.
  defaultAgent: AgentID;
  dirs: DirsConfig;
  workspaces: WorkspacesConfig;

  // The credential references an agent's auth selects from, by profile
  // name, and the problems that kept a profile out.
  authProfiles: ReadonlyMap<string, AuthProfile>;
  authProfileErrors: readonly string[];
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

  // The workspace config problems, one line each.
  workspaceErrors: readonly string[];

  // Whether the daemon restores the stored fleet by itself after a restart.
  restoreFleetOnRestart: boolean;

  // The keys the file sets that atc no longer reads, in the order the file
  // holds them. Values are never recorded.
  removedKeys: readonly string[];
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
  agents: [
    {
      id: 'claude',
      kind: 'claude',
      label: 'Claude',
      mark: 'c',
      bin: 'claude',
      args: [],
      env: {},
    },
  ],
  agentErrors: [],
  legacyAgentKeys: [],
  defaultAgent: 'claude',
  dirs: { roots: [] },
  workspaces: {
    githubOwner: null,
    sources: null,
    gitTransports: DEFAULT_GIT_TRANSPORTS,
    root: null,
    targetRoots: new Map(),
  },
  authProfiles: new Map(),
  authProfileErrors: [],
  hooks: {},
  leader: { code: 0, label: '^Space' },
  targets: [{ id: 'local', provider: 'local-pty', options: {} }],
  defaultTarget: 'local',
  targetErrors: [],
  principals: null,
  principalErrors: [],
  workspaceErrors: [],
  restoreFleetOnRestart: true,
  removedKeys: [],
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

// Where `atc daemon restart` keeps its run logs and the record of the last
// finished restart, and the lock that admits one restart at a time.
export const restartsDir = join(stateDir, 'restarts');
export const restartLockFile = join(stateDir, 'daemon-restart.lock');

// A user-written config.json's top-level keys. An absent or wrong-typed
// field parses to undefined rather than failing the file, so a bad config
// falls back to a default instead of refusing to start atc.
const CONFIG_SCHEMA = z.object({
  agents: z.unknown().optional(),
  claudeBin: buildOptionalString(),
  claudeArgs: buildOptionalStringArray(),
  claudeAuth: z.unknown().optional(),
  grokBin: buildOptionalString(),
  grokArgs: buildOptionalStringArray(),
  codexBin: buildOptionalString(),
  codexArgs: buildOptionalStringArray(),
  dirs: z.unknown().optional(),
  workspaces: z.unknown().optional(),
  gateways: z.unknown().optional(),
  authProfiles: z.unknown().optional(),
  hooks: z.unknown().optional(),
  leader: buildOptionalString(),
  targets: z.unknown().optional(),
  defaultTarget: z.unknown().optional(),
  principals: z.unknown().optional(),
  restoreFleetOnRestart: buildOptionalBoolean(),
});

/**
 * Reads and parses config.json. Only an absent file means every default,
 * the implicit `local` target included, and a first run writes those
 * defaults out. A file that exists but cannot be read or parsed loads as
 * unusable: every default but the targets, which it leaves empty with the
 * problem as the one target error, so nothing runs until the file is fixed.
 * `home` is the directory a `~` in the file expands to, and `state` is the
 * state directory it creates. Never throws.
 */
export function loadConfig(
  file: string = configFile,
  home: string = resolveHomeDir(),
  state: string = stateDir,
): Config {
  // Every atc process writes under the state directory; a failure here
  // comes back from the first write into it.
  try {
    mkdirSync(state, { recursive: true });
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

  return parseConfig(raw, file, home);
}

/**
 * A config for a file that exists but cannot be used: every default but the
 * targets, which are empty, with no default target and the file's problem
 * as the one target error, and the principals, which get no target, since
 * the file's own principals cannot be read.
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
    principals: new Map(),
  };
}

/**
 * Writes the first-run config, never over a file that appeared since the
 * read. The text goes to a file of this process's own first and is linked
 * into place whole, so another process that starts at the same moment
 * reads either no file or the complete one, never a half-written one. A
 * failure leaves the defaults in effect for this run, so it is not an
 * error.
 */
function tryWriteDefaultConfig(file: string): void {
  const staged = `${file}.${process.pid}.tmp`;

  try {
    mkdirSync(dirname(file), { recursive: true });

    try {
      writeFileSync(staged, renderDefaultConfig(), { flag: 'wx' });
      linkSync(staged, file);
    } finally {
      rmSync(staged, { force: true });
    }
  } catch {}
}

/**
 * The config.json text a first run writes: the `claude` agent alone. It
 * leaves out the targets and principals, so the file holds the one implicit `local` target and no
 * principals until the user sets their own, no auth profiles, and the
 * errors a parse reports, which belong to no file.
 */
export function renderDefaultConfig(): string {
  const {
    agents: _agents,
    agentErrors: _agentErrors,
    legacyAgentKeys: _legacyAgentKeys,
    defaultAgent: _defaultAgent,
    authProfiles: _authProfiles,
    authProfileErrors: _authProfileErrors,
    targets: _targets,
    defaultTarget: _default,
    targetErrors: _errors,
    principals: _principals,
    principalErrors: _principalErrors,
    workspaceErrors: _workspaceErrors,
    removedKeys: _removedKeys,
    workspaces,
    ...written
  } = DEFAULTS;

  // The target roots are a map in memory and an object of target ids in
  // the file.
  const { targetRoots, ...rest } = workspaces;

  return `${JSON.stringify(
    {
      agents: { claude: {} },
      ...written,
      workspaces: { ...rest, targets: Object.fromEntries(targetRoots) },
    },
    null,
    2,
  )}\n`;
}

/**
 * Parses a user-written config.json's already-decoded JSON value into a
 * Config, applying every default a malformed or absent field falls back to.
 * A root that is not an object leaves the config unusable, with no targets,
 * and `file` is the path its error holds. `home` is the directory a `~` in
 * a directory root or a hook's `dir` expands to. Total: no shape of `raw`
 * throws, so a hand-edited config never stops atc starting.
 */
export function parseConfig(
  raw: unknown,
  file: string = configFile,
  home: string = resolveHomeDir(),
): Config {
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

  const present = Object.keys(raw).filter((key) => LEGACY_AGENT_KEYS.includes(key));

  if (Object.hasOwn(raw, 'agents') && present.length > 0) {
    return buildUnusableConfig('config_malformed', file, formatMixedAgentKeys(present));
  }

  const dirs = { roots: collectDirRoots(parsed.data.dirs, home) };
  const workspaces = collectWorkspacesConfig(parsed.data.workspaces);
  const authProfiles = collectAuthProfiles(parsed.data.authProfiles);

  const registry = Object.hasOwn(raw, 'agents')
    ? collectAgents(parsed.data.agents, authProfiles.profiles)
    : collectLegacyAgents(
        {
          claudeBin: parsed.data.claudeBin ?? 'claude',
          claudeArgs: parsed.data.claudeArgs ?? [],
          claudeAuth: parsed.data.claudeAuth,
          grokBin: parsed.data.grokBin ?? 'grok',
          grokArgs: parsed.data.grokArgs ?? [],
          codexBin: parsed.data.codexBin ?? 'codex',
          codexArgs: parsed.data.codexArgs ?? [],
          gateways: parsed.data.gateways,
        },
        authProfiles.profiles,
      );

  const hooks = collectHooks(parsed.data.hooks, home);
  const targets = collectTargets(parsed.data.targets, parsed.data.defaultTarget);
  const principals = collectPrincipals(parsed.data.principals);

  const leader =
    (parsed.data.leader === undefined ? null : decodeLeader(parsed.data.leader)) ?? DEFAULTS.leader;

  return {
    agents: registry.agents,
    agentErrors: registry.errors,
    legacyAgentKeys: present,
    defaultAgent: pickDefaultAgent(registry.agents),
    dirs,
    workspaces: workspaces.workspaces,
    authProfiles: authProfiles.profiles,
    authProfileErrors: authProfiles.errors,
    hooks,
    leader,
    targets: targets.targets,
    defaultTarget: targets.defaultTarget,
    targetErrors: targets.errors,
    principals: principals.principals,
    principalErrors: principals.errors,
    workspaceErrors: workspaces.errors,
    restoreFleetOnRestart: parsed.data.restoreFleetOnRestart ?? DEFAULTS.restoreFleetOnRestart,
    removedKeys: REMOVED_CONFIG_KEYS.filter((key) => Object.hasOwn(raw, key)),
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
