import { toSessionID } from '@atcx/contract';
import { faker } from '@faker-js/faker';
import type { Session } from '../sessions/session';

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
    spawner: null,
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
