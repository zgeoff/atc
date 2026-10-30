import type { Config, RemoteDaemon } from '@atc/config';
import type { ProcessIO } from './process-io';
import { resolveRemoteDaemon } from './resolve-remote-daemon';

interface NamedDaemonSource {
  readonly loadConfig: () => Pick<Config, 'daemons' | 'daemonErrors'>;
  readonly configFile: string;
  readonly io: Pick<ProcessIO, 'printError' | 'exit'>;
}

// Null once the command has refused the name and exited.
export function readNamedDaemon(
  name: string,
  command: string,
  source: NamedDaemonSource,
): RemoteDaemon | null {
  const picked = resolveRemoteDaemon(source.loadConfig(), name, source.configFile);

  if (!picked.ok) {
    source.io.printError(`${command}: ${picked.message}`);
    source.io.exit(1);

    return null;
  }

  return picked.daemon;
}
