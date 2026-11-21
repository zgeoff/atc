import type { MockOverrides } from '@atc/core/test-utils/mock-overrides';
import { faker } from '@faker-js/faker';
import { mergeDeep } from '@zgeoff/std';
import type { MirrorSession } from '../fleet/to-mirror-session';

export function buildMockMirrorSession(
  overrides: MockOverrides<MirrorSession, keyof MirrorSession> = {},
): MirrorSession {
  const cwd = faker.system.directoryPath();

  return mergeDeep<MirrorSession>(
    {
      daemon: null,
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
      place: { key: 'daemon:local:local', label: 'local' },
      model: null,
      harness: 'running',
    },
    overrides,
  );
}
