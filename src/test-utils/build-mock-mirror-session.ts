import { faker } from '@faker-js/faker';
import type { MirrorSession } from '../client/to-mirror-session';
import { mergeDeep } from './merge-deep';
import type { MockOverrides } from './mock-overrides';

/**
 * A client's mirror of a live, running Claude session in a local terminal
 * on the `local` target: read, unpinned, not resumable, unable to eject,
 * with no parent and the agent's default model. The id, name, directory,
 * last message, and times are arbitrary. Overrides replace the defaults
 * field by field.
 */
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
