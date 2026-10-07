import { faker } from '@faker-js/faker';
import type { SessionDescriptor } from '../daemon/sessions';
import { toDaemonID } from '../shared/to-daemon-id';
import { toSessionID } from '../shared/to-session-id';
import { mergeDeep } from './merge-deep';
import type { MockOverrides } from './mock-overrides';

/**
 * The fields the defaults set; every other field is absent until an
 * override gives it whole.
 */
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

/**
 * The wire view of a live, running Claude session in a local terminal on
 * the `local` target, as `session.list` and the session events carry it:
 * read, unpinned, named by the user, with no parent, workspace, model, or
 * agent session id. The id, name, directories, last message, times, and
 * daemon id are arbitrary. Overrides merge into fresh defaults at every
 * depth.
 */
export function buildMockSessionInfo(
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
