import type { DaemonContext } from '../daemon/daemon-context';
import { TargetAccess } from '../daemon/target-access';
import { toDaemonID } from '../shared/to-daemon-id';

/**
 * A daemon context for a connection under test with no daemon behind it.
 * It answers what a handshake and outbound delivery read: build
 * `atc/test`, daemon id `d-1`, a 64 KiB outbound queue, a day of
 * idempotency retention, no sessions, `claude` as the last used agent, no
 * target access, a local grant for every session, every session visible,
 * and resyncs, detaches, and tap detaches that do nothing. Every other
 * member throws with its name, so a test that reaches one learns which it
 * must override. An override replaces the member it names.
 */
export function buildStubDaemonContext(overrides: Partial<DaemonContext> = {}): DaemonContext {
  return {
    build: 'atc/test',
    daemonID: toDaemonID('d-1'),
    idempotencyRetentionMs: 86_400_000,
    queueBytes: 65_536,
    collectSessions: () => [],
    collectSpawnDirs: makeUnreachable('collectSpawnDirs'),
    collectAgents: makeUnreachable('collectAgents'),
    collectFleet: makeUnreachable('collectFleet'),
    loadLastUsedAgent: () => Promise.resolve('claude'),
    findAdapter: makeUnreachable('findAdapter'),
    buildTargetAccess: () => new TargetAccess([]),
    findSessionGrant: () => ({ target: 'local', targetIdentity: 'local-pty' }),
    hasListedPrincipal: makeUnreachable('hasListedPrincipal'),
    findTargetIdentity: makeUnreachable('findTargetIdentity'),
    canSeeSession: () => true,
    isSessionVisible: makeUnreachable('isSessionVisible'),
    findPermissionSession: makeUnreachable('findPermissionSession'),
    resolveSpawnParent: makeUnreachable('resolveSpawnParent'),
    resolveSpawnTarget: makeUnreachable('resolveSpawnTarget'),
    requireWorkspaceTarget: makeUnreachable('requireWorkspaceTarget'),
    buildDefaultWorkspaceDir: makeUnreachable('buildDefaultWorkspaceDir'),
    requireAgentTarget: makeUnreachable('requireAgentTarget'),
    findSource: makeUnreachable('findSource'),
    collectAlternateGitURLs: makeUnreachable('collectAlternateGitURLs'),
    checkRepositoryAccess: makeUnreachable('checkRepositoryAccess'),
    spawnSession: makeUnreachable('spawnSession'),
    killSession: makeUnreachable('killSession'),
    forgetSession: makeUnreachable('forgetSession'),
    revokeSessionAuth: makeUnreachable('revokeSessionAuth'),
    updateSessionAuth: makeUnreachable('updateSessionAuth'),
    updateSession: makeUnreachable('updateSession'),
    quitDaemon: makeUnreachable('quitDaemon'),
    ackSession: makeUnreachable('ackSession'),
    buildResumeCommand: makeUnreachable('buildResumeCommand'),
    readSessionScreen: makeUnreachable('readSessionScreen'),
    readSessionRecord: makeUnreachable('readSessionRecord'),
    loadSessionTranscript: makeUnreachable('loadSessionTranscript'),
    readEvents: makeUnreachable('readEvents'),
    readReport: makeUnreachable('readReport'),
    answerPermission: makeUnreachable('answerPermission'),
    restoreFleet: makeUnreachable('restoreFleet'),
    attachSession: makeUnreachable('attachSession'),
    detachSession: () => {},
    detachClient: makeUnreachable('detachClient'),
    writeSessionInput: makeUnreachable('writeSessionInput'),
    writeSessionLine: makeUnreachable('writeSessionLine'),
    ejectSession: makeUnreachable('ejectSession'),
    adoptSession: makeUnreachable('adoptSession'),
    resizeSession: makeUnreachable('resizeSession'),
    resyncClient: () => Promise.resolve(),
    getEffectiveDims: makeUnreachable('getEffectiveDims'),
    writeSessionMessage: makeUnreachable('writeSessionMessage'),
    readMessage: makeUnreachable('readMessage'),
    attachTap: makeUnreachable('attachTap'),
    detachTap: () => {},
    ackMessage: makeUnreachable('ackMessage'),
    ...overrides,
  };
}

function makeUnreachable(member: string): () => never {
  return () => {
    throw new Error(`the stub daemon context has no ${member}`);
  };
}
