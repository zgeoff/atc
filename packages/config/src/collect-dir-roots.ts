import { isRecord } from '@atc/core';
import { resolveHomeDir } from '@atcx/contract/light';
import { normalizeConfigDir } from './normalize-config-dir';

export function collectDirRoots(raw: unknown, home: string = resolveHomeDir()): readonly string[] {
  if (!isRecord(raw) || !Array.isArray(raw['roots'])) {
    return [];
  }

  const roots: string[] = [];

  for (const item of raw['roots']) {
    if (typeof item !== 'string' || item === '') {
      continue;
    }

    roots.push(normalizeConfigDir(item, home));
  }

  return roots;
}
