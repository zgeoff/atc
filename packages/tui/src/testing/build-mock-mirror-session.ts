import type { MockOverrides } from '@atc/test-utils';
import { faker } from '@faker-js/faker';
import { mergeDeep } from '@zgeoff/std';
import type { MirrorSession } from '../to-mirror-session';

export function buildMockMirrorSession(
  overrides: MockOverrides<MirrorSession, keyof MirrorSession> = {},
): MirrorSession {
  const cwd = faker.system.directoryPath();

  return mergeDeep<MirrorSession>(
    {
      id: faker.string.uuid(),
      name: faker.word.noun(),
      cwd,
      pinned: false,
      lastAttachedAt: faker.date.recent().getTime(),
      repoRoot: cwd,
      state: 'running',
      unread: false,
      lastMsg: faker.lorem.sentence(),
      createdAt: faker.date.past().getTime(),
      kind: 'pty',
      alive: true,
      resumable: false,
      canEject: false,
      agent: 'claude',
      parent: null,
      target: 'local',
      model: null,
      harness: 'running',
    },
    overrides,
  );
}
