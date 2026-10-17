import { isRecord } from '@atc/core';
import { buildOptionalNonEmptyString } from '@atc/core/schema';
import { z } from 'zod';
import { resolveHomeDir } from './host/resolve-home-dir';
import { normalizeConfigDir } from './normalize-config-dir';

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

// an unknown event name is kept: it never fires, and a daemon that emits it
// later starts firing without a config change.
export function collectHooks(raw: unknown, home: string = resolveHomeDir()): HooksConfig {
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
        ...(parsed.data.dir === undefined
          ? {}
          : { dir: normalizeConfigDir(parsed.data.dir, home) }),
        ...(parsed.data.timeout === undefined ? {} : { timeout: parsed.data.timeout }),
      });
    }

    if (entries.length > 0) {
      hooks[event] = entries;
    }
  }

  return hooks;
}

function buildOptionalPositiveNumber() {
  return z.preprocess(
    (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined),
    z.number().optional(),
  );
}
