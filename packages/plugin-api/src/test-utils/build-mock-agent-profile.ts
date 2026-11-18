import type { MockOverrides } from '@atc/core/test-utils/mock-overrides';
import type { SpawnOptionSpec } from '@atcx/contract';
import { faker } from '@faker-js/faker';
import { mergeDeep } from '@zgeoff/std';
import type { AgentProfile } from '../index';

type DefaultedKey = 'label' | 'kind' | 'bin' | 'models' | 'spawnOptions';

export function buildMockAgentProfile(
  overrides: MockOverrides<AgentProfile, DefaultedKey> = {},
): AgentProfile {
  return mergeDeep<AgentProfile>(
    {
      label: faker.company.name(),
      kind: 'claude',
      bin: faker.system.filePath(),
      models: null,
      spawnOptions: {
        model: buildUnsupportedOption(),
        effort: buildUnsupportedOption(),
      },
    },
    overrides,
  );
}

function buildUnsupportedOption(): SpawnOptionSpec {
  return {
    supported: false,
    values: null,
    examples: [],
    default: null,
    backendEffect: null,
    note: null,
  };
}
