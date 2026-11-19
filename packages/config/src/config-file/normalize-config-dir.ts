import { expandHome } from '@atc/core';

export function normalizeConfigDir(directory: string, home: string): string {
  const trimmed = expandHome(directory, home).replace(/\/+$/u, '');

  return trimmed === '' ? '/' : trimmed;
}
