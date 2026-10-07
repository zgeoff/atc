/**
 * The script of a stand-in `atc` whose daemon hands its socket to a
 * replacement: it moves the socket listening at `listeningPath` to
 * `$HOME/atc-daemon.sock`, where a client of a daemon on that home dials,
 * and exits 0. Write it with `createStubBin`.
 */
export function buildStubHandoffDaemon(listeningPath: string): string {
  return `#!/usr/bin/env bash
mv '${listeningPath}' "$HOME/atc-daemon.sock"
`;
}
