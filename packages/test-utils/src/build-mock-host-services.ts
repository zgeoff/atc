import { systemClock } from '@atc/core';
import type { HostServices } from '@atc/plugin-api';
import { faker } from '@faker-js/faker';
import { mergeDeep } from './merge-deep';
import type { MockOverrides } from './mock-overrides';

export function buildMockHostServices(
  overrides: MockOverrides<HostServices, keyof HostServices> = {},
): HostServices {
  const version = faker.system.semver();

  return mergeDeep<HostServices>(
    {
      atcArgv: [faker.system.filePath()],
      version,
      build: `${version}+bin.${faker.string.alphanumeric(8)}`,

      // Answers as a shell does for a command missing from PATH, so no test runs a
      // command on the machine.
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
