import { expandHome } from '@atc/core';

export function normalizeConfigDir(dir: string, home: string): string {
  const trimmed = expandHome(dir, home).replace(/\/+$/u, '');

  return trimmed === '' ? '/' : trimmed;
}
