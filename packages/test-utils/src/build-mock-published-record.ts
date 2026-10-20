import type { PublishedRecord } from '@atc/protocol';
import { faker } from '@faker-js/faker';
import { mergeDeep } from '@zgeoff/std';
import type { MockOverrides } from './mock-overrides';

type DefaultedKey = keyof PublishedRecord;

export function buildMockPublishedRecord(
  overrides: MockOverrides<PublishedRecord, DefaultedKey> = {},
): PublishedRecord {
  return mergeDeep<PublishedRecord>(
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
