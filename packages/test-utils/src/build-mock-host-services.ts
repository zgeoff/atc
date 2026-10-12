import { systemClock } from '@atc/core/system-clock';
import type { HostServices } from '@atc/plugin-api/host-services';
import { faker } from '@faker-js/faker';
import { mergeDeep } from './merge-deep';
import type { MockOverrides } from './mock-overrides';

/**
 * Host services for a test: an argv that runs an arbitrary compiled atc,
 * an arbitrary version and a build stamped from it, a command runner that
 * finds no command, the way a shell reports one missing from PATH, so no
 * test runs a command on the machine, the wall clock, and a log that drops
 * every line. Overrides merge into fresh defaults at every depth.
 */
export function buildMockHostServices(
  overrides: MockOverrides<HostServices, keyof HostServices> = {},
): HostServices {
  const version = faker.system.semver();

  return mergeDeep<HostServices>(
    {
      atcArgv: [faker.system.filePath()],
      version,
      build: `${version}+bin.${faker.string.alphanumeric(8)}`,
      runCommand: (argv) =>
        Promise.resolve({
          code: 127,
          stdout: '',
          stderr: `${argv[0] ?? ''}: command not found`,
          aborted: false,
        }),
      clock: systemClock,
      log: () => {},
    },
    overrides,
  );
}
