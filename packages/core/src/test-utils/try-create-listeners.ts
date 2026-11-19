export function tryCreateListeners(hostnames: readonly string[]): boolean {
  for (const hostname of hostnames) {
    try {
      const listener = Bun.listen({ hostname, port: 0, socket: { data() {} } });

      listener.stop(true);

      // A host without the address, such as stock macOS for any loopback address
      // past 127.0.0.1, refuses the listener with EADDRNOTAVAIL.
    } catch {
      return false;
    }
  }

  return true;
}
