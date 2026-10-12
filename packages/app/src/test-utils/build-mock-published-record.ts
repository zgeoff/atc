import { faker } from '@faker-js/faker';
import type { PublishedRecord } from '../protocol/published-record';
import { mergeDeep } from './merge-deep';
import type { MockOverrides } from './mock-overrides';

type DefaultedKey = keyof PublishedRecord;

/**
 * A first-revision version 1 record of a fresh session on the local target,
 * whose workspace is an arbitrary directory on a branch, with no declared
 * scope. Overrides merge into fresh defaults at every depth.
 */
export function buildMockPublishedRecord(
  overrides: MockOverrides<PublishedRecord, DefaultedKey> = {},
): PublishedRecord {
  return mergeDeep<PublishedRecord, DefaultedKey>(
    {
      format: 'atc.session-record',
      version: 1,
      session: faker.string.uuid(),
      daemonID: faker.string.uuid(),
      target: 'local',
      revision: 1,
      updatedAt: faker.date.recent().toISOString(),
      scope: {
        workspace: {
          path: faker.system.directoryPath(),
          branch: faker.git.branch(),
          repoURL: null,
          sha: null,
        },
        worktrees: [],
        branches: [],
        pullRequests: [],
      },
    },
    overrides,
  );
}
