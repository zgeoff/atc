import { expandHome } from '@atc/core';

/**
 * A directory a config.json names, in the form atc compares: a leading `~`
 * or `~/` expanded to the home, and trailing slashes trimmed, so `/` stays
 * `/`.
 */
export function normalizeConfigDir(dir: string, home: string): string {
  const trimmed = expandHome(dir, home).replace(/\/+$/u, '');

  return trimmed === '' ? '/' : trimmed;
}
