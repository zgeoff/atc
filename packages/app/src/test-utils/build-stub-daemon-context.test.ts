import { expect, test } from 'bun:test';
import { toDaemonID } from '../shared/to-daemon-id';
import { toSessionID } from '../shared/to-session-id';
import { buildStubDaemonContext } from './build-stub-daemon-context';

test('it builds a daemon of build atc/test with id d-1 and a day of idempotency retention', () => {
  const daemon = buildStubDaemonContext();

  expect(daemon.build).toBe('atc/test');
  expect(daemon.daemonID).toBe(toDaemonID('d-1'));
  expect(daemon.idempotencyRetentionMs).toBe(86_400_000);
});

test('it holds no sessions', () => {
  expect(buildStubDaemonContext().collectSessions()).toStrictEqual([]);
});

test('it holds an empty fleet', () => {
  expect(buildStubDaemonContext().collectFleet()).resolves.toStrictEqual([]);
});

test('it loads claude as the last agent used', () => {
  expect(buildStubDaemonContext().loadLastUsedAgent()).resolves.toBe('claude');
});

test('it gives every principal access to no target', () => {
  expect(
    buildStubDaemonContext()
      .buildTargetAccess('narrow')
      .canUse({ target: 'local', targetIdentity: 'local-pty' }),
  ).toBeFalse();
});

test('it binds every session to the local target', () => {
  expect(buildStubDaemonContext().findSessionGrant(toSessionID('s-1'))).toStrictEqual({
    target: 'local',
    targetIdentity: 'local-pty',
  });
});

test('it lets every principal see every session', () => {
  const daemon = buildStubDaemonContext();

  expect(daemon.canSeeSession(toSessionID('s-1'), daemon.buildTargetAccess('narrow'))).toBeTrue();
});

test('it throws, naming the member, from a member no test wired', () => {
  expect(() => {
    buildStubDaemonContext().quitDaemon();
  }).toThrowWithMessage(Error, 'the stub daemon context has no quitDaemon');
});

test('it replaces the member an override names', () => {
  expect(buildStubDaemonContext({ build: 'atc/other' }).build).toBe('atc/other');
});

test('it holds a 64 KiB outbound queue', () => {
  expect(buildStubDaemonContext().queueBytes).toBe(65_536);
});

test('it resyncs a client by doing nothing', () => {
  const client = { sendOutput: () => {} };

  expect(
    buildStubDaemonContext().resyncClient(toSessionID('s-1'), client),
  ).resolves.toBeUndefined();
});
