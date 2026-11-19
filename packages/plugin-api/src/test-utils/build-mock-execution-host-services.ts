import type { MockOverrides } from '@atc/core/test-utils/mock-overrides';
import { faker } from '@faker-js/faker';
import type { ExecutionHostServices } from '../index';
import { buildMockHostServices } from './build-mock-host-services';

export function buildMockExecutionHostServices(
  overrides: MockOverrides<ExecutionHostServices, keyof ExecutionHostServices> = {},
): ExecutionHostServices {
  const { stateDir, ...rest } = overrides;

  return {
    ...buildMockHostServices(rest),
    stateDir: typeof stateDir === 'string' ? stateDir : faker.system.directoryPath(),
  };
}
