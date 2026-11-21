import type { MockOverrides } from '@atc/core/test-utils/mock-overrides';
import { faker } from '@faker-js/faker';
import { mergeDeep, systemClock } from '@zgeoff/std';
import type { HostServices } from '../index';

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
