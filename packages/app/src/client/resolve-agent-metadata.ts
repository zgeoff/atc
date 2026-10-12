import type { AgentID } from '../shared/agent-id';
import type { Config } from '../shared/config';
import { isRecord } from '../shared/report';

// What the overlay needs to know per agent to label a row: the readable
// name, and the tier-alias map a gateway's env configures.
export interface AgentMetadata {
  readonly labels: Readonly<Record<AgentID, string>>;

  // Per agent id, the alias-to-model mapping an `agents.list` entry
  // carries; absent for agents that take models by name only.
  readonly models: Readonly<Record<AgentID, Readonly<Record<string, string>>>>;
}

/**
 * The labels and model aliases the overlay draws with, resolved from the
 * config a client reads at start and the daemon's `agents.list` answer once
 * it arrives. The answer wins, so a backend the daemon registers under a
 * stand-in adapter still lists under its own name; the config alone covers
 * the window before the answer lands.
 */
export function resolveAgentMetadata(config: Config, listed: unknown): AgentMetadata {
  const labels: Record<AgentID, string> = {};
  const models: Record<AgentID, Readonly<Record<string, string>>> = {};

  for (const entry of config.agents) {
    if (isSafeKey(entry.id)) {
      labels[entry.id] = entry.label;
    }
  }

  if (isRecord(listed) && Array.isArray(listed['agents'])) {
    for (const entry of listed['agents']) {
      if (!isRecord(entry) || typeof entry['id'] !== 'string' || !isSafeKey(entry['id'])) {
        continue;
      }

      if (typeof entry['label'] === 'string' && entry['label'] !== '') {
        labels[entry['id']] = entry['label'];
      }

      if (isRecord(entry['models'])) {
        models[entry['id']] = pickModelAliases(entry['models']);
      }
    }
  }

  return { labels, models };
}

// The alias-to-model entries of an `agents.list` model map, keeping the
// string values a row can resolve and dropping anything else.
function pickModelAliases(values: Readonly<Record<string, unknown>>): Record<string, string> {
  const aliases: Record<string, string> = {};

  for (const [alias, model] of Object.entries(values)) {
    if (typeof model === 'string' && isSafeKey(alias)) {
      aliases[alias] = model;
    }
  }

  return aliases;
}

// A daemon-supplied id or alias can name `__proto__`, which would change a
// map's prototype instead of adding an entry, so such keys stay out.
function isSafeKey(key: string): boolean {
  return key !== '__proto__';
}
