import { expect, test } from 'bun:test';
import { TargetAccess } from '../daemon/target-access';
import { toDaemonID } from '../shared/to-daemon-id';
import { toSessionID } from '../shared/to-session-id';
import { buildStubDaemonContext } from './build-stub-daemon-context';

test('it builds a context that answers a handshake and outbound delivery', async () => {
  const context = buildStubDaemonContext();

  expect({
    build: context.build,
    daemonID: context.daemonID,
    idempotencyRetentionMs: context.idempotencyRetentionMs,
    queueBytes: context.queueBytes,
    sessions: context.collectSessions(),
    lastUsedAgent: await context.loadLastUsedAgent(),
    targetAccess: context.buildTargetAccess('narrow'),
    grant: context.findSessionGrant(toSessionID('s-1')),
    visible: context.canSeeSession(toSessionID('s-1'), new TargetAccess([])),
  }).toStrictEqual({
    build: 'atc/test',
    daemonID: toDaemonID('d-1'),
    idempotencyRetentionMs: 86_400_000,
    queueBytes: 65_536,
    sessions: [],
    lastUsedAgent: 'claude',
    targetAccess: new TargetAccess([]),
    grant: { target: 'local', targetIdentity: 'local-pty' },
    visible: true,
  });
});

test('it applies overrides on top of the defaults', () => {
  const context = buildStubDaemonContext({ queueBytes: 64, canSeeSession: () => false });

  expect({
    queueBytes: context.queueBytes,
    visible: context.canSeeSession(toSessionID('s-1'), new TargetAccess([])),
  }).toStrictEqual({ queueBytes: 64, visible: false });
});

test('it throws with the member name when a test reaches a member it did not override', () => {
  const context = buildStubDaemonContext();

  expect(() => {
    context.quitDaemon();
  }).toThrowWithMessage(Error, 'the stub daemon context has no quitDaemon');
});
