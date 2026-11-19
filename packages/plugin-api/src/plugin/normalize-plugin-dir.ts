import { expandHome } from '@atc/core';

// Drops only empty and . segments, which name the same folder through any
// symlink, and keeps a symlink unresolved, so a launch after the link moves
// loads the folder it names then.
export function normalizePluginDir(directory: string, home: string): string {
  const segments = expandHome(directory, home)
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.');

  return `/${segments.join('/')}`;
}
