export function isHomeRelative(path: string): boolean {
  return path === '~' || path.startsWith('~/');
}
