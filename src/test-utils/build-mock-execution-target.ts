import { faker } from '@faker-js/faker';
import type { ExecutionTarget } from '../daemon/build-execution-targets';
import { mergeDeep } from './merge-deep';
import type { MockOverrides } from './mock-overrides';

/**
 * A local-pty execution target with an arbitrary id and identity, no
 * options, and no provider, as a target of a kind this daemon lacks has.
 * Overrides merge into fresh defaults at every depth; a provider override
 * replaces the default whole.
 */
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
