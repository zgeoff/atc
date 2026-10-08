/**
 * Tries to bind a socket to every given address on this host, by listening
 * on a kernel-chosen port of each and closing it at once, and returns whether
 * every bind succeeded. A host
 * without an address, such as stock macOS for any loopback address past
 * 127.0.0.1, refuses the bind with EADDRNOTAVAIL.
 */
export function tryBindAddresses(hostnames: readonly string[]): boolean {
  for (const hostname of hostnames) {
    try {
      const listener = Bun.listen({ hostname, port: 0, socket: { data() {} } });

      listener.stop(true);
    } catch {
      return false;
    }
  }

  return true;
}
