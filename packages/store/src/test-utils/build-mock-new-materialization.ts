import type { MockOverrides } from '@atc/test-utils';
import { toSessionID } from '@atcx/contract';
import { faker } from '@faker-js/faker';
import { mergeDeep } from '@zgeoff/std';
import type { NewMaterialization } from '../workspace-materialization';

export function buildMockNewMaterialization(
  overrides: MockOverrides<NewMaterialization, keyof NewMaterialization> = {},
): NewMaterialization {
  return mergeDeep<NewMaterialization>(
    {
      sessionID: toSessionID(faker.string.uuid()),
      target: 'local',
      directory: faker.system.directoryPath(),
      sourceKind: 'git',
      withheldEnv: [],
    },
    overrides,
  );
}
