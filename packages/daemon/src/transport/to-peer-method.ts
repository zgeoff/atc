// The request method a procedure's path names: `/daemon/hello` is
// `daemon.hello`.
export function toPeerMethod(pathname: string): string {
  return pathname.replace(/^\//u, '').replaceAll('/', '.');
}
