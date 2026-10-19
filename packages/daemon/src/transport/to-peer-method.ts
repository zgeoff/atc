// A procedure's path in its one written form: a slash before each name,
// and nothing else.
const CANONICAL_PATH = /^(?:\/[A-Za-z]+)+$/u;

// The request method a procedure's path names: `/daemon/hello` is
// `daemon.hello`. A path in any other form names no method, so a check on
// the method never sees a form the router would read as another procedure.
export function toPeerMethod(pathname: string): string | null {
  return CANONICAL_PATH.test(pathname) ? pathname.slice(1).replaceAll('/', '.') : null;
}
