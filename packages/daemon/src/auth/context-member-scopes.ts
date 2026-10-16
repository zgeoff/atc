import type { DaemonContext } from '../daemon-context';

/**
 * How a request a principal sends reaches a member of the daemon's
 * context:
 *
 * - `narrowed`: the principal's context replaces the member with one that
 *   reaches only the sessions and targets the access holds.
 * - `daemon-wide`: the principal gets the daemon's own member, which holds
 *   or acts on nothing that belongs to one session or one target's
 *   sessions.
 * - `caller-checked`: the principal gets the daemon's own member, which
 *   reaches sessions; every request that calls it checks the session
 *   against the access first, or passes the access itself.
 * - `owner-only`: the principal gets the daemon's own member, which only a
 *   request open to the daemon's owner alone calls, and the connection
 *   refuses such a request from a principal before it builds the
 *   principal's context.
 */
export type ContextMemberScope = 'narrowed' | 'daemon-wide' | 'caller-checked' | 'owner-only';

/**
 * The scope of each member of the daemon's context. A member the table
 * leaves out fails to compile, so a new member reaches a principal only
 * once its scope is stated here.
 */
export const CONTEXT_MEMBER_SCOPES = {
  build: 'daemon-wide',
  daemonID: 'daemon-wide',
  idempotencyRetentionMs: 'daemon-wide',
  queueBytes: 'daemon-wide',
  loadLastUsedAgent: 'daemon-wide',
  findAdapter: 'daemon-wide',
  buildTargetAccess: 'daemon-wide',
  hasListedPrincipal: 'daemon-wide',
  findTargetIdentity: 'daemon-wide',
  requireWorkspaceTarget: 'daemon-wide',
  buildDefaultWorkspaceDir: 'daemon-wide',
  requireAgentTarget: 'daemon-wide',
  findSource: 'daemon-wide',
  collectAlternateGitURLs: 'daemon-wide',
  checkRepositoryAccess: 'daemon-wide',

  collectFleet: 'caller-checked',
  findSessionGrant: 'caller-checked',
  canSeeSession: 'caller-checked',
  findPermissionSession: 'caller-checked',
  isCallerTree: 'caller-checked',
  getEffectiveDims: 'caller-checked',
  resyncClient: 'caller-checked',
  detachClient: 'caller-checked',
  detachTap: 'caller-checked',

  quitDaemon: 'owner-only',
  restoreFleet: 'owner-only',
  writeStateBackup: 'owner-only',

  isSessionVisible: 'narrowed',
  collectSessions: 'narrowed',
  collectAgents: 'narrowed',
  collectSpawnDirs: 'narrowed',
  resolveSpawnParent: 'narrowed',
  resolveSpawnTarget: 'narrowed',
  spawnSession: 'narrowed',
  killSession: 'narrowed',
  forgetSession: 'narrowed',
  revokeSessionAuth: 'narrowed',
  updateSessionAuth: 'narrowed',
  updateSession: 'narrowed',
  updateSessionScope: 'narrowed',
  ackSession: 'narrowed',
  buildResumeCommand: 'narrowed',
  readSessionScreen: 'narrowed',
  readSessionMenu: 'narrowed',
  applySessionMenuChoice: 'narrowed',
  answerPermission: 'narrowed',
  attachSession: 'narrowed',
  detachSession: 'narrowed',
  writeSessionInput: 'narrowed',
  writeSessionLine: 'narrowed',
  ejectSession: 'narrowed',
  adoptSession: 'narrowed',
  resizeSession: 'narrowed',
  readSessionRecord: 'narrowed',
  loadSessionTranscript: 'narrowed',
  readEvents: 'narrowed',
  readNote: 'narrowed',
  readAnswer: 'narrowed',
  writeSessionMessage: 'narrowed',
  readMessage: 'narrowed',
  attachTap: 'narrowed',
  ackMessage: 'narrowed',
  ackNotice: 'narrowed',
} as const satisfies Record<keyof DaemonContext, ContextMemberScope>;
