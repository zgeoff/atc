import { toDaemonID, toSessionID } from '@atc/core';
import type { SessionDescriptor } from '@atc/protocol';
import { faker } from '@faker-js/faker';
import { mergeDeep } from './merge-deep';
import type { MockOverrides } from './mock-overrides';

type DefaultedKey =
  | 'id'
  | 'name'
  | 'cwd'
  | 'state'
  | 'unread'
  | 'lastMsg'
  | 'agent'
  | 'pinned'
  | 'lastAttachedAt'
  | 'repoRoot'
  | 'namedBy'
  | 'createdAt'
  | 'kind'
  | 'alive'
  | 'canEject'
  | 'locator'
  | 'lifecycle';

export function buildMockSessionDescriptor(
  overrides: MockOverrides<SessionDescriptor, DefaultedKey> = {},
): SessionDescriptor {
  const cwd = faker.system.directoryPath();

  return mergeDeep<SessionDescriptor, DefaultedKey>(
    {
      id: toSessionID(faker.string.uuid()),
      name: faker.word.noun(),
      cwd,
      state: 'running',
      unread: false,
      lastMsg: faker.lorem.sentence(),
      agent: 'claude',
      pinned: false,
      lastAttachedAt: faker.date.recent().getTime(),
      repoRoot: cwd,
      namedBy: 'user',
      createdAt: faker.date.past().getTime(),
      kind: 'pty',
      alive: true,
      canEject: false,
      locator: { daemonID: toDaemonID(faker.string.uuid()), targetID: 'local' },
      lifecycle: { desired: 'run', vm: 'none', harness: 'running', attachment: 'local' },
    },
    overrides,
  );
}
