import type { HarnessStart } from '@atc/plugin-api';
import { runLocalCommand } from '@atc/plugin-api/test-utils/run-local-command';
import { RESOLVE_AGENT_HOME_SCRIPT } from '../auth/read-host-agent-home';
import { buildStubMemoryProvider } from './build-stub-memory-provider';

interface StubGuestFilesProviderConfig {
  readonly guestDirectory: string;
  readonly hostDirectory: string;
  readonly harnessStart?: HarnessStart;
}

export function buildStubGuestFilesProvider(config: StubGuestFilesProviderConfig) {
  const guestDirectory = config.guestDirectory;
  const hostDirectory = config.hostDirectory;

  return buildStubMemoryProvider({
    kind: 'remote',
    remote: true,
    capabilities: { suspend: true, destroy: true },
    guest: { directory: guestDirectory, atc: `${guestDirectory}/bin/atc` },
    ...(config.harnessStart === undefined ? {} : { harnessStart: config.harnessStart }),
    runCommand: (spec) => {
      if (spec.argv[2] === RESOLVE_AGENT_HOME_SCRIPT) {
        return Promise.resolve({
          exitCode: 0,
          stdout: `${guestDirectory}/home/${spec.argv[5] ?? ''}\n`,
          stderr: '',
        });
      }

      return runLocalCommand({
        ...spec,
        argv: spec.argv.map((arg) =>
          arg === guestDirectory || arg.startsWith(`${guestDirectory}/`)
            ? `${hostDirectory}${arg.slice(guestDirectory.length)}`
            : arg,
        ),
      });
    },
  });
}
