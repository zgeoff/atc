import { isHomeRelative } from './is-home-relative';

export function expandHome(path: string, home: string): string {
  return isHomeRelative(path) ? `${home}${path.slice(1)}` : path;
}
