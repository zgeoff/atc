import { expandHome } from '@atc/core';

// Drops only empty and . segments, which name the same folder through any
// symlink, and keeps a symlink unresolved, so a launch after the link moves
// loads the folder it names then.
export function normalizePluginDir(dir: string, home: string): string {
  const segments = expandHome(dir, home)
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.');

  return `/${segments.join('/')}`;
}
