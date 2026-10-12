/**
 * A path as a person reads it: the home directory, or a path inside it,
 * written with a leading `~`. A path that only shares the home's prefix,
 * such as `/home/ab` beside `/home/a`, stays as it is.
 */
export function formatHomePath(path: string, home: string): string {
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
