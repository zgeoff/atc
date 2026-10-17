import { resolvePaths } from '@atc/config/host';
import { systemClock } from '@atc/core';
import { mergeDeep } from '@atc/test-utils';
import type { MockOverrides } from '@atc/test-utils';
import { faker } from '@faker-js/faker';
import type { LifecycleHost } from '../lifecycle-host';

export function buildMockLifecycleHost(
  overrides: MockOverrides<LifecycleHost, keyof LifecycleHost> = {},
): LifecycleHost {
  return mergeDeep<LifecycleHost>(
    {
      invocation: { argv: ['false'], readBuild: () => 'atc/test-build' },
      paths: resolvePaths({ HOME: faker.system.directoryPath() }),
      clock: systemClock,
      procRoot: '/proc',
      restoreBootTimeoutMs: 15_000,
      findManagedUnit: () => null,

      // a missing systemctl, so no test reaches a real service manager.
      runSystemctl: () =>
        Promise.resolve({
          code: 127,
          stdout: '',
          stderr: 'systemctl: command not found',
          aborted: false,
        }),
    },
    overrides,
  );
}
