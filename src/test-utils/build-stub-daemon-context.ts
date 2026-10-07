import type { DaemonContext } from '../daemon/daemon-context';
import { TargetAccess } from '../daemon/target-access';
import { toDaemonID } from '../shared/to-daemon-id';

/**
 * The daemon a connection serves, for tests that drive one connection
 * without a daemon behind it: build `atc/test`, daemon id `d-1`, a 64 KiB
 * outbound queue, a day's idempotency retention, no sessions, `claude` as
 * the last agent used, an empty fleet, a principal that reaches no target,
 * every session bound to the `local` target and visible, and resyncs and
 * detaches that do nothing. Every other
 * member throws when called, naming itself, so a test that reaches one it
 * did not wire fails loudly. An override replaces the member it names.
 */
export function buildStubDaemonContext(overrides: Partial<DaemonContext> = {}): DaemonContext {
  return {
    build: 'atc/test',
    daemonID: toDaemonID('d-1'),
    queueBytes: 65_536,
    idempotencyRetentionMs: 86_400_000,
    collectSessions: () => [],
    collectSpawnDirs: makeUnreached('collectSpawnDirs'),
    collectAgents: makeUnreached('collectAgents'),
    collectFleet: () => Promise.resolve([]),
    loadLastUsedAgent: () => Promise.resolve('claude'),
    findAdapter: makeUnreached('findAdapter'),
    buildTargetAccess: () => new TargetAccess([]),
    hasListedPrincipal: makeUnreached('hasListedPrincipal'),
    findSessionGrant: () => ({ target: 'local', targetIdentity: 'local-pty' }),
    findTargetIdentity: makeUnreached('findTargetIdentity'),
    canSeeSession: () => true,
    isSessionVisible: makeUnreached('isSessionVisible'),
    findPermissionSession: makeUnreached('findPermissionSession'),
    resolveSpawnParent: makeUnreached('resolveSpawnParent'),
    resolveSpawnTarget: makeUnreached('resolveSpawnTarget'),
    requireWorkspaceTarget: makeUnreached('requireWorkspaceTarget'),
    buildDefaultWorkspaceDir: makeUnreached('buildDefaultWorkspaceDir'),
    requireAgentTarget: makeUnreached('requireAgentTarget'),
    findSource: makeUnreached('findSource'),
    collectAlternateGitURLs: makeUnreached('collectAlternateGitURLs'),
    checkRepositoryAccess: makeUnreached('checkRepositoryAccess'),
    spawnSession: makeUnreached('spawnSession'),
    killSession: makeUnreached('killSession'),
    forgetSession: makeUnreached('forgetSession'),
    revokeSessionAuth: makeUnreached('revokeSessionAuth'),
    updateSessionAuth: makeUnreached('updateSessionAuth'),
    updateSession: makeUnreached('updateSession'),
    quitDaemon: makeUnreached('quitDaemon'),
    ackSession: makeUnreached('ackSession'),
    buildResumeCommand: makeUnreached('buildResumeCommand'),
    readSessionScreen: makeUnreached('readSessionScreen'),
    readSessionRecord: makeUnreached('readSessionRecord'),
    loadSessionTranscript: makeUnreached('loadSessionTranscript'),
    readEvents: makeUnreached('readEvents'),
    readReport: makeUnreached('readReport'),
    answerPermission: makeUnreached('answerPermission'),
    restoreFleet: makeUnreached('restoreFleet'),
    attachSession: makeUnreached('attachSession'),
    detachSession: () => {},
    detachClient: makeUnreached('detachClient'),
    writeSessionInput: makeUnreached('writeSessionInput'),
    writeSessionLine: makeUnreached('writeSessionLine'),
    ejectSession: makeUnreached('ejectSession'),
    adoptSession: makeUnreached('adoptSession'),
    resizeSession: makeUnreached('resizeSession'),
    resyncClient: () => Promise.resolve(),
    getEffectiveDims: makeUnreached('getEffectiveDims'),
    writeSessionMessage: makeUnreached('writeSessionMessage'),
    readMessage: makeUnreached('readMessage'),
    attachTap: makeUnreached('attachTap'),
    detachTap: () => {},
    ackMessage: makeUnreached('ackMessage'),
    ...overrides,
  };
}

function makeUnreached(member: string): () => never {
  return () => {
    throw new Error(`the stub daemon context has no ${member}`);
  };
}
