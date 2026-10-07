import { faker } from '@faker-js/faker';
import type { Session } from '../daemon/sessions';
import { toSessionID } from '../shared/to-session-id';

/**
 * A session manager's record of an exited Claude session on the `local`
 * target with no terminal: read, unpinned, auto-named, with no parent,
 * withheld env, workspace, model, or agent session id, and its own host.
 * The id, name, directories, and times are arbitrary. An override replaces
 * the field it names.
 */
export function buildMockSession(overrides: Partial<Session> = {}): Session {
  const id = overrides.id ?? toSessionID(faker.string.uuid());
  const cwd = faker.system.directoryPath();

  return {
    id,
    name: faker.word.noun(),
    cwd,
    kind: 'pty',
    pty: null,
    state: 'exited',
    unread: false,
    lastMsg: '',
    agent: 'claude',
    pinned: false,
    lastAttachedAt: faker.date.recent().getTime(),
    repoRoot: cwd,
    namedBy: 'auto',
    createdAt: faker.date.past().getTime(),
    parent: null,
    target: 'local',
    targetIdentity: 'local-pty:test',
    withheldEnv: [],
    desired: 'run',
    vm: 'none',
    attachment: 'local',
    suspended: false,
    hostKey: id,
    bridgeEpoch: 0,
    ...overrides,
  };
}
