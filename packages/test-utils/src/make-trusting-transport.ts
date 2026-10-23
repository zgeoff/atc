// A fetch that trusts one more certificate authority, such as a test's
// self-signed certificate, and keeps the rest of each request's TLS options.
export function makeTrustingTransport(
  ca: string,
): (target: string, init: BunFetchRequestInit) => Promise<Response> {
  return (target, init) => fetch(target, { ...init, tls: { ...init.tls, ca } });
}
