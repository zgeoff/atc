import { mergeDeep } from '@atc/test-utils';
import type { MockOverrides } from '@atc/test-utils';
import { faker } from '@faker-js/faker';
import type { ExecutionTarget } from '../fleet/build-execution-targets';

export function buildMockExecutionTarget(
  overrides: MockOverrides<ExecutionTarget, keyof ExecutionTarget> = {},
): ExecutionTarget {
  return mergeDeep<ExecutionTarget>(
    {
      id: faker.word.noun(),
      kind: 'local-pty',
      options: {},
      identity: `local-pty:${faker.string.uuid()}`,
      provider: null,
    },
    overrides,
  );
}
