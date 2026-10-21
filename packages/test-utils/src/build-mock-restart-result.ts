import type { RestartResult } from '@atc/protocol';
import { faker } from '@faker-js/faker';
import { mergeDeep } from '@zgeoff/std';
import type { MockOverrides } from './mock-overrides';

type DefaultedKey = keyof RestartResult;

export function buildMockRestartResult(
  overrides: MockOverrides<RestartResult, DefaultedKey> = {},
): RestartResult {
  return mergeDeep<RestartResult>(
    {
      runID: faker.string.uuid(),
      code: 0,
      pid: faker.number.int({ min: 2, max: 4_194_304 }),
      build: `atc/${faker.system.semver()}`,
      listenPort: null,
      restored: 0,
      total: 0,
      failed: [],
      interrupted: [],
      error: null,
    },
    overrides,
  );
}
