import type { AgentEntry } from './shared/collect-agents';
import { parseConfig } from './shared/config';
import { formatJSONKind } from './shared/format-json-kind';
import { formatMixedAgentKeys } from './shared/format-mixed-agent-keys';
import { LEGACY_AGENT_KEYS } from './shared/legacy-agent-keys';
import { REMOVED_CONFIG_KEYS } from './shared/removed-config-keys';
import { isRecord } from './shared/report';

/**
 * What `atc config migrate` makes of a config.json's decoded value: the file
 * rewritten around `agents` with a note per gateway it could not carry over,
 * a file that needs no change, or a file it cannot migrate.
 */
type MigratedConfig =
  | { readonly kind: 'migrated'; readonly text: string; readonly notes: readonly string[] }
  | { readonly kind: 'current' }
  | { readonly kind: 'unusable'; readonly detail: string };

/**
 * Rewrites a config.json that uses the old agent keys so it holds the same
 * agents under `agents`, and drops every key atc no longer reads. A file
 * that holds `agents` and a removed key is rewritten without the key. The old keys are removed and `agents` takes the
 * place of the first of them, or the end of the file when it sets none. Each
 * entry holds only the fields that differ from a default. Values are copied
 * and never reported, so a note names a key and a reason only.
 */
export function buildMigratedConfig(raw: unknown): MigratedConfig {
  if (!isRecord(raw) || Array.isArray(raw)) {
    return {
      kind: 'unusable',
      detail: `the root is ${formatJSONKind(raw)}, not an object`,
    };
  }

  const present = Object.keys(raw).filter((key) => LEGACY_AGENT_KEYS.includes(key));
  const removed = REMOVED_CONFIG_KEYS.filter((key) => Object.hasOwn(raw, key));

  const removedNotes = removed.map(
    (key) => `atc config migrate: ${key} is dropped: atc no longer reads it`,
  );

  if (Object.hasOwn(raw, 'agents')) {
    if (present.length > 0) {
      return { kind: 'unusable', detail: formatMixedAgentKeys(present) };
    }

    if (removed.length === 0) {
      return { kind: 'current' };
    }

    return {
      kind: 'migrated',
      text: `${JSON.stringify(Object.fromEntries(Object.entries(raw).filter(([key]) => !removed.includes(key))), null, 2)}\n`,
      notes: removedNotes,
    };
  }

  const config = parseConfig(raw);
  const agents: Record<string, unknown> = {};

  for (const entry of config.agents) {
    agents[entry.id] = renderAgentEntry(entry);
  }

  const migrated: Record<string, unknown> = {};
  let placed = false;

  for (const [key, value] of Object.entries(raw)) {
    if (removed.includes(key)) {
      continue;
    }

    if (!LEGACY_AGENT_KEYS.includes(key)) {
      migrated[key] = value;
    } else if (!placed) {
      migrated['agents'] = agents;
      placed = true;
    }
  }

  if (!placed) {
    migrated['agents'] = agents;
  }

  return {
    kind: 'migrated',
    text: `${JSON.stringify(migrated, null, 2)}\n`,
    notes: [
      ...collectDroppedGateways(raw['gateways'], config.agents, config.agentErrors),
      ...removedNotes,
    ],
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
      `atc config migrate: gateways.${id} is left out: ${findDropReason(id, entry, errors)}`,
    );
  }

  return notes;
}

const BUILT_IN_COUNT = 3;

function isDropped(id: string, kept: ReadonlySet<string>): boolean {
  return id === '__proto__' || !kept.has(id);
}

function findDropReason(id: string, entry: unknown, errors: readonly string[]): string {
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
