import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentID } from '@atc/core';
import { isRecord } from '@atc/core';
import { buildOptionalBoolean, buildOptionalString } from '@atc/core/schema';
import type { AuthProfile } from '@atc/plugin-api';
import { z } from 'zod';
import type { AgentConfigPlugin, AgentEntry } from './agent-entry';
import { buildCurrentPlaceholderConfig } from './build-current-placeholder-config';
import { collectAgents } from './collect-agents';
import { collectAuthProfiles } from './collect-auth-profiles';
import { collectDirRoots } from './collect-dir-roots';
import { collectHooks } from './collect-hooks';
import type { HooksConfig } from './collect-hooks';
import { collectPrincipals } from './collect-principals';
import { collectRemoteDaemons } from './collect-remote-daemons';
import type { RemoteDaemon } from './collect-remote-daemons';
import { collectTargets } from './collect-targets';
import type { TargetConfig, TargetConfigError } from './collect-targets';
import { collectWorkspacesConfig } from './collect-workspaces-config';
import type { WorkspacesConfig } from './collect-workspaces-config';
import { DEFAULT_GIT_TRANSPORTS } from './default-git-transports';
import { formatJSONKind } from './format-json-kind';
import { formatLegacyAgentKeys } from './format-legacy-agent-keys';
import { formatMixedAgentKeys } from './format-mixed-agent-keys';
import { configFile, stateDir } from './host/process-paths';
import { resolveHomeDir } from './host/resolve-home-dir';
import { LEGACY_AGENT_KEYS } from './legacy-agent-keys';
import { LOCAL_TARGET } from './local-target';
import { pickDefaultAgent } from './pick-default-agent';
import { REMOVED_CONFIG_KEYS } from './removed-config-keys';

export interface Config {
  // The agents atc offers, in menu order, and the problems that left an
  // entry out.
  agents: readonly AgentEntry[];
  agentErrors: readonly string[];

  // The old agent keys a file without `agents` sets, in file order. Empty
  // for a file that uses `agents` or sets none of them.

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

  // The daemons on other hosts the TUI may connect to by name, and the
  // problems that left an entry out.
  daemons: ReadonlyMap<string, RemoteDaemon>;
  daemonErrors: readonly string[];

  // Whether the daemon restores the stored fleet by itself after a restart.
  restoreFleetOnRestart: boolean;

  // The keys the file sets that atc no longer reads, in the order the file
  // holds them. Values are never recorded.
  removedKeys: readonly string[];

  // The values the file holds that atc still reads but a later release
  // stops reading, one line each.
  deprecations: readonly string[];
}

interface DirsConfig {
  readonly roots: readonly string[];
}

interface LeaderKey {
  readonly code: number;
  readonly label: string;
}

// Every default but the agents, which the harness plugins read from the
// first-run agents map.
const DEFAULTS: Omit<Config, 'agents' | 'agentErrors' | 'defaultAgent'> = {
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
  targets: [LOCAL_TARGET],
  defaultTarget: LOCAL_TARGET.id,
  targetErrors: [],
  principals: null,
  principalErrors: [],
  workspaceErrors: [],
  daemons: new Map(),
  daemonErrors: [],
  restoreFleetOnRestart: true,
  removedKeys: [],
  deprecations: [],
};

// A user-written config.json's top-level keys. An absent or wrong-typed
// field parses to undefined rather than failing the file, so a bad config
// falls back to a default instead of refusing to start atc.
const CONFIG_SCHEMA = z.object({
  agents: z.unknown().optional(),
  dirs: z.unknown().optional(),
  workspaces: z.unknown().optional(),
  authProfiles: z.unknown().optional(),
  hooks: z.unknown().optional(),
  leader: buildOptionalString(),
  targets: z.unknown().optional(),
  defaultTarget: z.unknown().optional(),
  principals: z.unknown().optional(),
  daemons: z.unknown().optional(),
  restoreFleetOnRestart: buildOptionalBoolean(),
});

// never throws: a file it cannot read or parse loads with no targets.
export function loadConfig(
  plugins: readonly AgentConfigPlugin[],
  file: string = configFile,
  home: string = resolveHomeDir(),
  state: string = stateDir,
): Config {
  // Every atc process writes under the state directory; a failure here
  // comes back from the first write into it. It may hold the daemon's
  // sockets, so each directory this creates is its owner's alone.
  try {
    mkdirSync(state, { recursive: true, mode: 0o700 });
  } catch {}

  let text: string;

  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    const code: unknown = error instanceof Error ? Reflect.get(error, 'code') : undefined;

    if (code !== 'ENOENT') {
      const detail = typeof code === 'string' ? code : 'the file could not be read';

      return buildUnusableConfig(plugins, 'config_unreadable', file, detail);
    }

    tryWriteDefaultConfig(file);

    return buildDefaultConfig(plugins);
  }

  let raw: unknown;

  try {
    raw = JSON.parse(text);
  } catch {
    // The parser's own message can quote the file's text, so the detail is
    // a fixed phrase instead.
    return buildUnusableConfig(plugins, 'config_malformed', file, 'the file is not valid JSON');
  }

  return parseConfig(plugins, raw, file, home);
}

// The agents map a first run writes.
const FIRST_RUN_AGENTS = { claude: {} };

// Every default, with the agents the plugins read from the first-run
// agents map.
function buildDefaultConfig(plugins: readonly AgentConfigPlugin[]): Config {
  const registry = collectAgents(FIRST_RUN_AGENTS, new Map(), plugins);

  return {
    agents: registry.agents,
    agentErrors: registry.errors,
    defaultAgent: pickDefaultAgent(registry.agents),
    ...DEFAULTS,
  };
}

function buildUnusableConfig(
  plugins: readonly AgentConfigPlugin[],
  problem: 'config_malformed' | 'config_unreadable',
  path: string,
  detail: string,
): Config {
  return {
    ...buildDefaultConfig(plugins),
    targets: [],
    defaultTarget: null,
    targetErrors: [{ scope: 'config', problem, path, detail }],
    principals: new Map(),
  };
}

// staged in a file of this process's own and linked into place whole, so a
// process starting at the same moment reads no file or the complete one, and
// a file that appeared since the read is never overwritten.
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

export function renderDefaultConfig(): string {
  const {
    authProfiles: _authProfiles,
    authProfileErrors: _authProfileErrors,
    targets: _targets,
    defaultTarget: _default,
    targetErrors: _errors,
    principals: _principals,
    principalErrors: _principalErrors,
    workspaceErrors: _workspaceErrors,
    daemons: _daemons,
    daemonErrors: _daemonErrors,
    removedKeys: _removedKeys,
    deprecations: _deprecations,
    workspaces,
    ...written
  } = DEFAULTS;

  // The target roots are a map in memory and an object of target ids in
  // the file.
  const { targetRoots, ...rest } = workspaces;

  return `${JSON.stringify(
    {
      agents: FIRST_RUN_AGENTS,
      ...written,
      workspaces: { ...rest, targets: Object.fromEntries(targetRoots) },
    },
    null,
    2,
  )}\n`;
}

// total: no shape of `raw` throws, so a hand-edited config never stops atc
// starting.
export function parseConfig(
  plugins: readonly AgentConfigPlugin[],
  raw: unknown,
  file: string = configFile,
  home: string = resolveHomeDir(),
): Config {
  if (!isRecord(raw) || Array.isArray(raw)) {
    return buildUnusableConfig(
      plugins,
      'config_malformed',
      file,
      `the root is ${formatJSONKind(raw)}, not an object`,
    );
  }

  const replacement = buildCurrentPlaceholderConfig(raw);
  const parsed = CONFIG_SCHEMA.safeParse(replacement.config);

  if (!parsed.success) {
    return buildUnusableConfig(
      plugins,
      'config_malformed',
      file,
      'the file does not match the config schema',
    );
  }

  const present = Object.keys(raw).filter((key) => LEGACY_AGENT_KEYS.includes(key));

  if (Object.hasOwn(raw, 'agents') && present.length > 0) {
    return buildUnusableConfig(plugins, 'config_malformed', file, formatMixedAgentKeys(present));
  }

  if (present.length > 0) {
    return buildUnusableConfig(plugins, 'config_malformed', file, formatLegacyAgentKeys(present));
  }

  const dirs = { roots: collectDirRoots(parsed.data.dirs, home) };
  const workspaces = collectWorkspacesConfig(parsed.data.workspaces);
  const authProfiles = collectAuthProfiles(parsed.data.authProfiles);

  const agentMap = Object.hasOwn(raw, 'agents')
    ? parsed.data.agents
    : Object.fromEntries(plugins.map((plugin) => [plugin.id, { kind: plugin.id }]));

  const registry = collectAgents(agentMap, authProfiles.profiles, plugins);
  const hooks = collectHooks(parsed.data.hooks, home);
  const targets = collectTargets(parsed.data.targets, parsed.data.defaultTarget);
  const principals = collectPrincipals(parsed.data.principals);
  const daemons = collectRemoteDaemons(parsed.data.daemons, home);

  const leader =
    (parsed.data.leader === undefined ? null : decodeLeader(parsed.data.leader)) ?? DEFAULTS.leader;

  return {
    agents: registry.agents,
    agentErrors: registry.errors,
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
    daemons: daemons.daemons,
    daemonErrors: daemons.errors,
    restoreFleetOnRestart: parsed.data.restoreFleetOnRestart ?? DEFAULTS.restoreFleetOnRestart,
    removedKeys: REMOVED_CONFIG_KEYS.filter((key) => Object.hasOwn(raw, key)),
    deprecations: replacement.warning === null ? [] : [replacement.warning],
  };
}

// Control bytes the terminal needs for its own input: enter, tab, and esc
// as leaders would swallow ordinary typing.
const RESERVED_CODES = new Set([0x09, 0x0d, 0x1b]);

function decodeLeader(name: string): LeaderKey | null {
  const m = /^ctrl-(?<key>.+)$/iu.exec(name.trim().toLowerCase());
  const key = m?.groups?.['key'];

  if (key === undefined) {
    return null;
  }

  if (key === 'space') {
    return { code: 0, label: '^Space' };
  }

  let code: number | null = null;
  const cp = key.codePointAt(0);

  if (/^[a-z]$/u.test(key) && cp !== undefined) {
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
