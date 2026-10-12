/**
 * Whether a path is written relative to the home directory: `~` alone or
 * `~/` followed by more. `~user` forms are not.
 */
export function isHomeRelative(path: string): boolean {
  return path === '~' || path.startsWith('~/');
}
