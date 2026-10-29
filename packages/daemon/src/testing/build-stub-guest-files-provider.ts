import { buildStubMemoryProvider } from './build-stub-memory-provider';
import { runLocalCommand } from './run-local-command';

interface StubGuestFilesProviderConfig {
  // The folder where the remote host keeps atc's files.
  readonly guestDirectory: string;

  // The folder on the daemon's machine that holds what the guest folder holds.
  readonly hostDirectory: string;
}

// Stands in for a remote host whose files the daemon reaches only through a command: each
// command runs on the daemon's machine with every argument in the guest folder moved into the
// host folder, so a guest file is missing at its guest path on the daemon.
export function buildStubGuestFilesProvider(config: StubGuestFilesProviderConfig) {
  const guestDirectory = config.guestDirectory;
  const hostDirectory = config.hostDirectory;

  return buildStubMemoryProvider({
    kind: 'remote',
    remote: true,
    capabilities: { suspend: true, destroy: true },
    guest: { directory: guestDirectory, atc: null },
    runCommand: (spec) =>
      runLocalCommand({
        ...spec,
        argv: spec.argv.map((arg) =>
          arg === guestDirectory || arg.startsWith(`${guestDirectory}/`)
            ? `${hostDirectory}${arg.slice(guestDirectory.length)}`
            : arg,
        ),
      }),
  });
}
