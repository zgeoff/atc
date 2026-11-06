import type { AgentEntry } from '@atc/config';
import {
  LEGACY_AGENT_KEYS,
  REMOVED_CONFIG_KEYS,
  buildCurrentPlaceholderConfig,
  buildLegacySources,
  collectAuthProfiles,
  formatJSONKind,
  formatMixedAgentKeys,
  formatMixedSourceKeys,
} from '@atc/config';
import { isRecord } from '@atc/core';
import { buildOptionalString, buildOptionalStringArray } from '@atcx/contract/schema';
import { z } from 'zod';
import { collectLegacyAgents } from './shared/collect-legacy-agents';

type MigratedConfig =
  | { readonly kind: 'migrated'; readonly text: string; readonly notes: readonly string[] }
  | { readonly kind: 'current'; readonly registries: readonly string[] }
  | { readonly kind: 'unusable'; readonly detail: string };

export function buildMigratedConfig(file: unknown): MigratedConfig {
  if (!isRecord(file) || Array.isArray(file)) {
    return {
      kind: 'unusable',
      detail: `the root is ${formatJSONKind(file)}, not an object`,
    };
  }

  // the migrated file holds atc's own placeholder, so the parse below keeps
  // each entry that holds the deprecated one
  const raw = buildCurrentPlaceholderConfig(file).config;
  const present = Object.keys(raw).filter((key) => LEGACY_AGENT_KEYS.includes(key));
  const removed = REMOVED_CONFIG_KEYS.filter((key) => Object.hasOwn(raw, key));
  const legacySources = buildLegacySources(raw);
  const [firstSourceKey] = legacySources.keys;
  const hasAgents = Object.hasOwn(raw, 'agents');
  const hasSources = Object.hasOwn(raw, 'sources');

  if (hasAgents && present.length > 0) {
    return { kind: 'unusable', detail: formatMixedAgentKeys(present) };
  }

  // no rule picks between a value in sources and one in an old key, so the
  // user moves them by hand
  if (hasSources && firstSourceKey !== undefined) {
    return { kind: 'unusable', detail: formatMixedSourceKeys(firstSourceKey) };
  }

  const registries = ['agents', 'sources'].filter((key) => Object.hasOwn(raw, key));

  // a file that uses either registry and sets no old agent key already reads
  // its agents as atc does, so only a file that uses neither gets agents
  const movesAgents = present.length > 0 || registries.length === 0;

  if (!movesAgents && firstSourceKey === undefined && removed.length === 0) {
    return { kind: 'current', registries };
  }

  // a note names a key and a reason only, never a value
  const removedNotes = removed.map(
    (key) => `atc config migrate: ${key} is dropped: atc no longer reads it`,
  );

  const kept = Object.fromEntries(Object.entries(raw).filter(([key]) => !removed.includes(key)));
  const agents = movesAgents ? moveAgentKeys(kept, raw, present) : { config: kept, notes: [] };

  const migrated =
    firstSourceKey === undefined
      ? agents.config
      : moveSourceKeys(agents.config, legacySources.sources);

  return {
    kind: 'migrated',
    text: `${JSON.stringify(migrated, null, 2)}\n`,
    notes: [
      ...agents.notes,
      ...legacySources.problems.map((problem) => `atc config migrate: ${problem}`),
      ...removedNotes,
    ],
  };
}

// The old agent keys and the auth profiles they may name. An absent or
// wrong-typed key parses to undefined and takes its default.
const LEGACY_KEYS_SCHEMA = z.object({
  claudeBin: buildOptionalString(),
  claudeArgs: buildOptionalStringArray(),
  claudeAuth: z.unknown().optional(),
  grokBin: buildOptionalString(),
  grokArgs: buildOptionalStringArray(),
  codexBin: buildOptionalString(),
  codexArgs: buildOptionalStringArray(),
  gateways: z.unknown().optional(),
  authProfiles: z.unknown().optional(),
});

// The file with the old agent keys replaced by an agents map at the
// position of the first one, or at the end when it sets none.
function moveAgentKeys(
  config: Readonly<Record<string, unknown>>,
  raw: Readonly<Record<string, unknown>>,
  present: readonly string[],
): { readonly config: Record<string, unknown>; readonly notes: readonly string[] } {
  const keys = LEGACY_KEYS_SCHEMA.parse(raw);
  const authProfiles = collectAuthProfiles(keys.authProfiles).profiles;

  const legacy = collectLegacyAgents(
    {
      claudeBin: keys.claudeBin ?? 'claude',
      claudeArgs: keys.claudeArgs ?? [],
      claudeAuth: keys.claudeAuth,
      grokBin: keys.grokBin ?? 'grok',
      grokArgs: keys.grokArgs ?? [],
      codexBin: keys.codexBin ?? 'codex',
      codexArgs: keys.codexArgs ?? [],
      gateways: keys.gateways,
    },
    authProfiles,
  );

  const agents: Record<string, unknown> = {};

  for (const entry of legacy.agents) {
    agents[entry.id] = renderAgentEntry(entry);
  }

  const moved: Record<string, unknown> = {};
  let placed = false;

  for (const [key, value] of Object.entries(config)) {
    if (!present.includes(key)) {
      moved[key] = value;
    } else if (!placed) {
      moved['agents'] = agents;
      placed = true;
    }
  }

  if (!placed) {
    moved['agents'] = agents;
  }

  return {
    config: moved,
    notes: collectDroppedGateways(raw['gateways'], legacy.agents, legacy.errors),
  };
}

// The fields of an entry that differ from the defaults the `agents` parser
// applies, so a migrated entry reads as short as one written by hand.
function renderAgentEntry(entry: AgentEntry): Record<string, unknown> {
  const rendered: Record<string, unknown> = {};

  if (entry.baseURL !== undefined) {
    rendered['kind'] = 'claude';
  }

  if (entry.label !== entry.id && entry.baseURL !== undefined) {
    rendered['label'] = entry.label;
  }

  if (
    entry.baseURL !== undefined &&
    entry.mark !== String.fromCodePoint(entry.id.codePointAt(0) ?? 0)
  ) {
    rendered['mark'] = entry.mark;
  }

  if (entry.bin !== entry.kind) {
    rendered['bin'] = entry.bin;
  }

  if (entry.args.length > 0) {
    rendered['args'] = entry.args;
  }

  if (entry.baseURL !== undefined) {
    rendered['baseURL'] = entry.baseURL;
  }

  if (entry.apiKeyHelper !== undefined) {
    rendered['apiKeyHelper'] = entry.apiKeyHelper;
  }

  if (Object.keys(entry.env).length > 0) {
    rendered['env'] = entry.env;
  }

  if (entry.settings !== undefined) {
    rendered['settings'] = entry.settings;
  }

  if (entry.auth !== undefined) {
    rendered['auth'] = {
      profiles: entry.auth.profiles,
      ...(Object.keys(entry.auth.placeholderEnv).length > 0
        ? { placeholderEnv: entry.auth.placeholderEnv }
        : {}),
      ...(entry.auth.args === undefined ? {} : { args: entry.auth.args }),
      ...(entry.mcpServers === undefined
        ? {}
        : {
            mcpServers: Object.fromEntries(
              entry.mcpServers.map((server) => [
                server.name,
                { url: server.url, profile: server.profile },
              ]),
            ),
          }),
    };
  }

  return rendered;
}

const BUILT_IN_COUNT = 3;

// One note per gateway the old parse left out, with the reason.
function collectDroppedGateways(
  raw: unknown,
  agents: readonly AgentEntry[],
  errors: readonly string[],
): string[] {
  if (!isRecord(raw) || Array.isArray(raw)) {
    return [];
  }

  // The three built-in agents come first, so the gateways follow them.
  const kept = new Set(agents.slice(BUILT_IN_COUNT).map((entry) => entry.id));

  const notes: string[] = [];

  for (const [id, entry] of Object.entries(raw)) {
    if (!isDropped(id, kept)) {
      continue;
    }

    notes.push(
      `atc config migrate: gateways.${id} is left out: ${pickDropReason(id, entry, errors)}`,
    );
  }

  return notes;
}

function isDropped(id: string, kept: ReadonlySet<string>): boolean {
  return id === '__proto__' || !kept.has(id);
}

function pickDropReason(id: string, entry: unknown, errors: readonly string[]): string {
  if (id === '') {
    return 'its id is empty';
  }

  if (id === '__proto__') {
    return 'its id cannot be used';
  }

  if (id === 'claude' || id === 'grok' || id === 'codex') {
    return `its id is the built-in agent ${id}`;
  }

  const baseURL = isRecord(entry) ? entry['baseURL'] : undefined;

  if (typeof baseURL !== 'string' || baseURL === '') {
    return 'it has no baseURL';
  }

  const prefix = `gateways.${id}: `;
  const problems = errors.filter((error) => error.startsWith(prefix));

  return problems.length > 0
    ? problems.map((problem) => problem.slice(prefix.length)).join('; ')
    : 'its entry could not be read';
}

// The old source keys this moves into sources.
const OLD_WORKSPACE_SOURCE_KEYS: readonly string[] = ['githubOwner', 'sources'];

// The file with `sources` at the position of the first top-level key that
// holds an old source key, and those keys removed. A `workspaces` section
// left empty goes too.
function moveSourceKeys(
  config: Readonly<Record<string, unknown>>,
  sources: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const moved: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(config)) {
    const workspaces =
      key === 'workspaces' && isRecord(value) && !Array.isArray(value) ? value : null;

    const holdsOldKey =
      key === 'dirs' ||
      (workspaces !== null &&
        OLD_WORKSPACE_SOURCE_KEYS.some((name) => Object.hasOwn(workspaces, name)));

    if (holdsOldKey && !Object.hasOwn(moved, 'sources')) {
      moved['sources'] = sources;
    }

    if (key === 'dirs') {
      continue;
    }

    if (workspaces === null) {
      moved[key] = value;
      continue;
    }

    const rest = Object.fromEntries(
      Object.entries(workspaces).filter(([name]) => !OLD_WORKSPACE_SOURCE_KEYS.includes(name)),
    );

    if (Object.keys(rest).length > 0) {
      moved[key] = rest;
    }
  }

  return moved;
}
