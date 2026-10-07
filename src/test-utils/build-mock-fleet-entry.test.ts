import { expect, test } from 'bun:test';
import { toSessionID } from '../shared/to-session-id';
import { buildMockFleetEntry } from './build-mock-fleet-entry';

test('it builds a default fleet entry', () => {
  expect(buildMockFleetEntry()).toStrictEqual({
    sessionID: expect.toBeString(),
    name: expect.toBeString(),
    cwd: expect.toStartWith('/'),
    agentSessionID: expect.toBeString(),
    agent: 'claude',
  });
});

test('it applies overrides on top of the defaults', () => {
  expect(
    buildMockFleetEntry({
      sessionID: toSessionID('s-kept'),
      name: 'kept',
      exited: true,
      workspace: {
        repoURL: 'https://example.com/acme/app.git',
        sha: 'abc123',
        materializedAt: 1000,
      },
    }),
  ).toStrictEqual({
    sessionID: toSessionID('s-kept'),
    name: 'kept',
    cwd: expect.toStartWith('/'),
    agentSessionID: expect.toBeString(),
    agent: 'claude',
    exited: true,
    workspace: { repoURL: 'https://example.com/acme/app.git', sha: 'abc123', materializedAt: 1000 },
  });
});
