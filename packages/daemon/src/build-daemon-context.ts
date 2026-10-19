import type { Clock } from '@atc/core';
import type { StateStore } from '@atc/store';
import { buildTargetAccess } from './auth/build-target-access';
import { isTreeInReach } from './auth/is-tree-in-reach';
import type { DaemonContext } from './daemon-context';
import type { DaemonOptions } from './daemon-options';
import type { ExecutionTarget } from './fleet/build-execution-targets';
import type { PermissionPrompts } from './sessions/permission-prompts';
import type { SessionManager } from './sessions/sessions';
import type { SessionServices } from './start-session-services';

export interface DaemonContextDeps {
  readonly opts: DaemonOptions;
  readonly store: StateStore;
  readonly mgr: SessionManager;
  readonly clock: Clock;
  readonly targets: readonly ExecutionTarget[];
  readonly targetsByID: ReadonlyMap<string, ExecutionTarget>;
  readonly principals: ReadonlyMap<string, readonly string[]> | null;
  readonly permissions: PermissionPrompts;
  readonly services: SessionServices;
  readonly idempotencyRetentionMs: number;

  // Stops the daemon once it is listening; undefined before then.
  readonly stopDaemon: () => Promise<void> | undefined;
}

// How long a client-requested quit waits before it stops the daemon, so the
// ok response to the quit request flushes before the sockets close under it.
const QUIT_FLUSH_DELAY_MS = 80;

export function buildDaemonContext(deps: DaemonContextDeps): DaemonContext {
  const opts = deps.opts;
  const store = deps.store;
  const mgr = deps.mgr;
  const clock = deps.clock;
  const targets = deps.targets;
  const targetsByID = deps.targetsByID;
  const principals = deps.principals;
  const permissions = deps.permissions;
  const stopDaemon = deps.stopDaemon;
  const catalog = deps.services.catalog;
  const spawns = deps.services.spawns;
  const forgetter = deps.services.forgetter;
  const handoff = deps.services.handoff;
  const input = deps.services.input;
  const output = deps.services.output;
  const restorer = deps.services.restorer;
  const reads = deps.services.reads;
  const trail = deps.services.trail;
  const messages = deps.services.messages;

  return {
    build: opts.build,
    daemonID: store.daemonID,
    idempotencyRetentionMs: deps.idempotencyRetentionMs,
    collectSessions: () => mgr.collectDescriptors(),
    readSpawnDirs: (access) => catalog.readSpawnDirs(access),
    collectAgents: () => catalog.collectAgents(),
    readFleet: () => store.loadFleet(),
    loadLastUsedAgent: () => store.loadLastUsedAgent(),
    findAdapter: (kind) => mgr.findAdapter(kind),
    buildTargetAccess: (principal) => buildTargetAccess(principals, targetsByID, principal),
    hasListedPrincipal: (principal) => principals?.has(principal) ?? false,
    findSessionGrant: (id) => {
      const s = mgr.sessions.find((x) => x.id === id);

      return s === undefined ? null : { target: s.target, targetIdentity: s.targetIdentity };
    },
    findTargetIdentity: (target) => targets.find((x) => x.id === target)?.identity ?? null,
    canSeeSession: (id, access) => isTreeInReach(mgr.sessions, id, access),
    isSessionVisible: () => true,
    findPermissionSession: (request) => permissions.findSessionID(request),
    resolveSpawnParent: (id) => spawns.resolveSpawnParent(id),
    resolveSpawnTarget: (requested) => spawns.resolveSpawnTarget(requested),
    requireWorkspaceTarget: (target) => {
      spawns.requireWorkspaceTarget(target);
    },
    buildDefaultWorkspaceDir: (target, source) => spawns.buildDefaultWorkspaceDir(target, source),
    requireAgentTarget: (agent, target) => {
      spawns.requireAgentTarget(agent, target);
    },
    requirePluginDirs: (target, configured, requested) =>
      spawns.requirePluginDirs(target, configured, requested),
    findSource: (id) => catalog.findSource(id),
    collectAlternateGitURLs: (url) => catalog.collectAlternateGitURLs(url),
    checkRepositoryAccess: (request) => catalog.checkRepositoryAccess(request),
    spawnSession: (plan, keyed, access) => spawns.spawnSession(plan, keyed, access),
    updateSession: (id, changes) => mgr.updateSession(id, changes),
    updateSessionScope: (id, scope) => mgr.updateScope(id, scope),
    isCallerTree: (id, caller) => mgr.isCallerTree(id, caller),
    quitDaemon: () => {
      clock.schedule(() => {
        void (async () => {
          await stopDaemon();

          opts.onQuit?.();
        })();
      }, QUIT_FLUSH_DELAY_MS);
    },
    killSession: (id, stopOnly) => forgetter.killSession(id, stopOnly),
    forgetSession: (id, confirmToken, refuse, caller) =>
      forgetter.forgetSession(id, confirmToken, refuse, caller),
    revokeSessionAuth: (id) => mgr.revokeAuth(id),
    updateSessionAuth: (id) => mgr.updateAuth(id),
    ejectSession: (id, prompt) => handoff.yankSession(id, prompt),
    adoptSession: (id, cols, rows, access) => handoff.adoptSession(id, cols, rows, access),
    ackSession: (id) => {
      if (!mgr.sessions.some((s) => s.id === id)) {
        return false;
      }

      mgr.ack(id);

      return true;
    },
    planResumeCommand: (id) => mgr.planResumeCommand(id),

    readSessionScreen: (id) => input.readSessionScreen(id),
    readSessionMenu: (id) => input.readSessionMenu(id),
    applySessionMenuChoice: (id, choice) => input.applySessionMenuChoice(id, choice),
    answerPermission: (request, decision) => permissions.answer(request, decision),
    attachSession: (client, sessionID, dims) => output.attachSession(client, sessionID, dims),
    detachSession: (client, sessionID) => {
      output.detachSession(client, sessionID);
    },
    detachClient: (client) => {
      output.detachClient(client);
    },
    writeSessionInput: (sessionID, data) => input.writeSessionInput(sessionID, data),
    writeSessionLine: (sessionID, text) => input.writeSessionLine(sessionID, text),
    resizeSession: (client, sessionID, dims) => output.updateSessionDims(client, sessionID, dims),
    resyncClient: (sessionID, client) => output.sendReplay(sessionID, client),
    ...(opts.queueBytes === undefined ? {} : { queueBytes: opts.queueBytes }),
    getEffectiveDims: (sessionID) => output.getEffectiveDims(sessionID),
    restoreFleet: (cols, rows) => restorer.runFleetRestore(cols, rows),
    writeStateBackup: (path) => store.writeBackup(path),
    readSessionRecord: (id, access) => reads.readSessionRecord(id, access),
    loadSessionTranscript: (id, from, limit) => reads.loadSessionTranscript(id, from, limit),
    readEvents: (afterID, limit, waitMs, sessionID, access) =>
      trail.readEvents(afterID, limit, waitMs, sessionID, access),
    readNote: (id, access) => trail.readNote(id, access),
    readAnswer: (id, access) => trail.readAnswer(id, access),
    writeSessionMessage: (sessionID, caller, text, keyed, access, callerSession) =>
      messages.writeSessionMessage(sessionID, caller, text, keyed, access, callerSession),
    attachTap: (client, sessionID, access, notices) =>
      messages.attachTap(client, sessionID, access, notices),
    detachTap: (client, sessionID) => {
      messages.detachTap(client, sessionID);
    },
    readMessage: (messageID, waitMs) => messages.readMessage(messageID, waitMs),
    ackMessage: (client, sessionID, messageID, access) =>
      messages.ackMessage(client, sessionID, messageID, access),
    ackNotice: (client, sessionID, messageID) => messages.ackNotice(client, sessionID, messageID),
  };
}
