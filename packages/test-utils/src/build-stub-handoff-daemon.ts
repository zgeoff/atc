export function buildStubHandoffDaemon(listeningPath: string): string {
  return `#!/usr/bin/env bash
mv '${listeningPath}' "$HOME/atc-daemon.sock"
`;
}
