const CANONICAL_PATH = /^(?:\/[A-Za-z]+)+$/u;

// The router can read a path in any other form, such as one with a trailing or doubled slash,
// as a different procedure. Mapping only the written form keeps a method check from passing a
// request the router sends elsewhere.
export function toPeerMethod(pathname: string): string | null {
  return CANONICAL_PATH.test(pathname) ? pathname.slice(1).replaceAll('/', '.') : null;
}
