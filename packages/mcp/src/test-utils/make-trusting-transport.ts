export function makeTrustingTransport(
  ca: string,
): (target: string, init: BunFetchRequestInit) => Promise<Response> {
  return (target, init) => fetch(target, { ...init, tls: { ...init.tls, ca } });
}
