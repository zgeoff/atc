import { resolvePaths } from '@atc/config/host';
import type { MockOverrides } from '@atc/core/test-utils/mock-overrides';
import { faker } from '@faker-js/faker';
import { mergeDeep, systemClock } from '@zgeoff/std';
import { tryOpenDaemon } from '../boot/try-open-daemon';
import type { LifecycleHost } from '../boot/types';

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
      openDaemon: tryOpenDaemon,
    },
    overrides,
  );
}
