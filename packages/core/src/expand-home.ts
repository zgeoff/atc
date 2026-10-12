import { isHomeRelative } from './is-home-relative';

/**
 * A path with a leading `~` or `~/` replaced by the home directory; any
 * other path unchanged.
 */
export function expandHome(path: string, home: string): string {
  return isHomeRelative(path) ? `${home}${path.slice(1)}` : path;
}
