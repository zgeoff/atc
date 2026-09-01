import { homedir } from 'node:os';
import { z } from 'zod';
import { isRecord } from './report';

/**
 * One configured hook: a shell command the daemon runs when the named wire
 * event broadcasts. `dir` narrows it to sessions whose repo root or working
 * directory sits at or under that path; `timeout` caps the run in
 * milliseconds before the process is killed.
 */
export interface HookEntry {
  readonly command: string;
  readonly dir?: string;
  readonly timeout?: number;
}

export type HooksConfig = Readonly<Record<string, readonly HookEntry[]>>;

// One hook entry's keys. A wrong-typed optional field parses to undefined
// rather than failing the entry, so a hook with one bad field still runs
// with the default for it.
const HOOK_ENTRY_SCHEMA = z.object({
  command: buildOptionalNonEmptyString(),
  dir: buildOptionalNonEmptyString(),
  timeout: buildOptionalPositiveNumber(),
});

/**
 * Reads the hooks map, keyed by wire-event name. An entry without a command
 * is left out; an event name with no valid entries is dropped. Unknown event
 * names are kept as written — they never fire, and a future daemon that
 * emits them starts firing without a config change. A `dir` is stored with
 * `~` expanded and trailing slashes trimmed, ready for path matching.
 */
export function collectHooks(raw: unknown): HooksConfig {
  if (!isRecord(raw)) {
    return {};
  }

  const hooks: Record<string, readonly HookEntry[]> = {};

  for (const [event, value] of Object.entries(raw)) {
    if (event === '' || !Array.isArray(value)) {
      continue;
    }

    const entries: HookEntry[] = [];

    for (const item of value) {
      const parsed = HOOK_ENTRY_SCHEMA.safeParse(item);

      if (!parsed.success || parsed.data.command === undefined) {
        continue;
      }

      entries.push({
        command: parsed.data.command,
        ...(parsed.data.dir === undefined ? {} : { dir: normalizeHookDir(parsed.data.dir) }),
        ...(parsed.data.timeout === undefined ? {} : { timeout: parsed.data.timeout }),
      });
    }

    if (entries.length > 0) {
      hooks[event] = entries;
    }
  }

  return hooks;
}

function normalizeHookDir(dir: string): string {
  const expanded = dir === '~' ? homedir() : dir.replace(/^~\//u, `${homedir()}/`);
  const trimmed = expanded.replace(/\/+$/u, '');

  return trimmed === '' ? '/' : trimmed;
}

function buildOptionalNonEmptyString() {
  return z.preprocess(
    (v) => (typeof v === 'string' && v !== '' ? v : undefined),
    z.string().optional(),
  );
}

function buildOptionalPositiveNumber() {
  return z.preprocess(
    (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined),
    z.number().optional(),
  );
}
