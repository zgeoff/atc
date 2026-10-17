import { isRecord } from '@atc/core';
import type { AuthProfile } from '@atc/plugin-api';
import type { AgentConfigPlugin, AgentEntry, ParsedAgentEntry } from './agent-entry';

interface CollectedAgents {
  readonly agents: AgentEntry[];

  // One line per problem, each starting with the entry it refused.
  readonly errors: string[];
}

export function collectAgents(
  raw: unknown,
  authProfiles: ReadonlyMap<string, AuthProfile>,
  plugins: readonly AgentConfigPlugin[],
): CollectedAgents {
  if (!isRecord(raw) || Array.isArray(raw)) {
    return { agents: [], errors: ['agents must be an object of agent entries'] };
  }

  const agents: AgentEntry[] = [];
  const errors: string[] = [];

  for (const [id, entry] of Object.entries(raw)) {
    const parsed = parseAgentEntry({ id, raw: entry, authProfiles, plugins });

    if ('problems' in parsed) {
      errors.push(...parsed.problems.map((problem) => `agents.${id}: ${problem}`));
    } else {
      agents.push(parsed.entry);
      errors.push(...parsed.warnings.map((warning) => `agents.${id}: ${warning}`));
    }
  }

  return { agents, errors };
}

interface AgentEntryArgs {
  readonly id: string;
  readonly raw: unknown;
  readonly authProfiles: ReadonlyMap<string, AuthProfile>;
  readonly plugins: readonly AgentConfigPlugin[];
}

function parseAgentEntry(
  args: AgentEntryArgs,
): ParsedAgentEntry | { readonly problems: readonly string[] } {
  if (args.id === '' || args.id === '__proto__') {
    return { problems: ['the id cannot be used'] };
  }

  if (!isRecord(args.raw) || Array.isArray(args.raw)) {
    return { problems: ['the entry must be an object'] };
  }

  const found = findPlugin(args.id, args.raw['kind'], args.plugins);

  if ('problem' in found) {
    return { problems: [found.problem] };
  }

  const foreignFields = new Set(
    args.plugins
      .filter((plugin) => plugin !== found.plugin)
      .flatMap((plugin) => plugin.configFields),
  );

  const schema = found.plugin.configSchema({
    authProfiles: args.authProfiles,
    entryID: args.id,
    foreignFields,
  });

  const result = schema.safeParse(args.raw);

  return result.success
    ? result.data
    : { problems: result.error.issues.map((issue) => issue.message) };
}

// The plugin an entry's kind selects, or the problem that refuses it. An
// absent kind is the id for an id that is a plugin's own, and a problem
// for any other.
function findPlugin(
  id: string,
  kind: unknown,
  plugins: readonly AgentConfigPlugin[],
): { readonly plugin: AgentConfigPlugin } | { readonly problem: string } {
  const named = plugins.find((plugin) => plugin.id === id);
  const ids = formatIDList(plugins.map((plugin) => plugin.id).toSorted());

  if (kind === undefined) {
    return named === undefined
      ? { problem: `kind is required for an id other than ${ids}` }
      : { plugin: named };
  }

  const selected = plugins.find((plugin) => plugin.id === kind);

  if (selected === undefined) {
    return { problem: `kind must be ${ids}` };
  }

  if (named !== undefined && named !== selected) {
    return { problem: `kind ${selected.id} contradicts the id ${id}` };
  }

  return { plugin: selected };
}

// Sorted ids as a list in prose: "claude, codex, or grok".
function formatIDList(ids: readonly string[]): string {
  if (ids.length <= 2) {
    return ids.join(' or ');
  }

  return `${ids.slice(0, -1).join(', ')}, or ${ids.at(-1)}`;
}
