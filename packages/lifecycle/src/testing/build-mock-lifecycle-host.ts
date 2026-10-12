import { resolvePaths } from '@atc/config/resolve-paths';
import { systemClock } from '@atc/core/system-clock';
import { mergeDeep } from '@atc/test-utils/merge-deep';
import type { MockOverrides } from '@atc/test-utils/mock-overrides';
import { faker } from '@faker-js/faker';
import type { LifecycleHost } from '../lifecycle-host';

/**
 * A lifecycle host for a test: an invocation that runs `false` and reads the
 * build `atc/test-build`, the paths of an arbitrary home without a runtime
 * directory, the wall clock, the real `/proc`, the 15 s restore boot time,
 * no installed user unit, and a `systemctl` that is missing, the way a
 * machine without systemd reports it, so no test reaches a real service
 * manager. Overrides merge into fresh defaults at every depth.
 */
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
