export function buildStubHandoffDaemon(listeningPath: string, daemonSocketPath: string): string {
  return `#!/usr/bin/env bash
mv '${listeningPath}' '${daemonSocketPath}'
`;
}
