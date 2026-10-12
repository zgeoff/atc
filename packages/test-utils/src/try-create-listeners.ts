/**
 * Creates a listener on a kernel-chosen port of every given address on this
 * host and closes each at once, and returns whether every listener could be
 * created, in place of the throw a failed one raises. A host without an
 * address, such as stock macOS for any loopback address past 127.0.0.1,
 * refuses the listener with EADDRNOTAVAIL.
 */
export function tryCreateListeners(hostnames: readonly string[]): boolean {
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
