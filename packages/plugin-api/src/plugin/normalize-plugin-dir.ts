import { expandHome } from '@atc/core';

export function normalizePluginDir(directory: string, home: string): string {
  const segments = expandHome(directory, home)
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.');

  return `/${segments.join('/')}`;
}
