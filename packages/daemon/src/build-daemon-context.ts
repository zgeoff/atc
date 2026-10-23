import type { Clock } from '@atc/core';
import { PROTOCOL_V } from '@atc/protocol/wire';
import type { EventMsg } from '@atc/protocol/wire';
import type { StateStore } from '@atc/store';
import { buildTargetAccess } from './auth/build-target-access';
import { isTreeInReach } from './auth/is-tree-in-reach';
import type { DaemonContext } from './daemon-context';
import type { DaemonOptions } from './daemon-options';
import type { ExecutionTarget } from './fleet/build-execution-targets';
import type { PermissionPrompts } from './sessions/create-permission-prompts';
import type { SessionManager } from './sessions/create-session-manager';
import type { SessionServices } from './start-session-services';

export interface DaemonContextDeps {
  readonly opts: DaemonOptions;
  readonly store: StateStore;
  readonly manager: SessionManager;
  readonly clock: Clock;
  readonly targets: readonly ExecutionTarget[];
  readonly targetsByID: ReadonlyMap<string, ExecutionTarget>;
  readonly principals: ReadonlyMap<string, readonly string[]> | null;
  readonly permissions: PermissionPrompts;
  readonly services: SessionServices;
  readonly idempotencyRetentionMs: number;
  readonly emitEvent: (event: EventMsg) => void;

  // Stops the daemon once it is listening; undefined before then.
  readonly stopDaemon: () => Promise<void> | undefined;
}

// How long a client-requested quit waits before it stops the daemon, so the
// ok response to the quit request flushes before the sockets close under it.
const QUIT_FLUSH_DELAY_MS = 80;

export function buildDaemonContext(deps: DaemonContextDeps): DaemonContext {
  const opts = deps.opts;
  const store = deps.store;
  const manager = deps.manager;
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
    collectSessions: () => manager.collectDescriptors(),
    readSpawnDirs: (access) => catalog.readSpawnDirs(access),
    collectAgents: () => catalog.collectAgents(),
    readFleet: () => store.loadFleet(),
    loadLastUsedAgent: () => store.loadLastUsedAgent(),
    findAdapter: (kind) => manager.findAdapter(kind),
    buildTargetAccess: (principal) => buildTargetAccess(principals, targetsByID, principal),
    hasListedPrincipal: (principal) => principals?.has(principal) ?? false,
    findSessionGrant: (id) => {
      const session = manager.sessions.find((x) => x.id === id);

      return session === undefined
        ? null
        : { target: session.target, targetIdentity: session.targetIdentity };
    },
    findTargetIdentity: (target) => targets.find((x) => x.id === target)?.identity ?? null,
    canSeeSession: (id, access) => isTreeInReach(manager.sessions, id, access),
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
    updateSession: (id, changes) => manager.updateSession(id, changes),
    updateSessionScope: (id, scope) => manager.updateScope(id, scope),
    isCallerTree: (id, caller) => manager.isCallerTree(id, caller),
    quitDaemon: () => {
      clock.schedule(() => {
        void (async () => {
          await stopDaemon();

          opts.onQuit?.();
        })();
      }, QUIT_FLUSH_DELAY_MS);
    },
    announceRestart: async (result) => {
      await trail.recordRestart(result);

      deps.emitEvent({ version: PROTOCOL_V, ev: 'DaemonRestarted', result });
    },
    killSession: (id, stopOnly) => forgetter.killSession(id, stopOnly),
    forgetSession: (id, confirmToken, refuse, caller) =>
      forgetter.forgetSession(id, confirmToken, refuse, caller),
    revokeSessionAuth: (id) => manager.revokeAuth(id),
    updateSessionAuth: (id) => manager.updateAuth(id),
    ejectSession: (id, prompt) => handoff.yankSession(id, prompt),
    adoptSession: (id, cols, rows, access) => handoff.adoptSession(id, cols, rows, access),
    ackSession: (id) => {
      if (!manager.sessions.some((session) => session.id === id)) {
        return false;
      }

      manager.ack(id);

      return true;
    },
    planResumeCommand: (id) => manager.planResumeCommand(id),

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
    readEvents: (params) => trail.readEvents(params),
    readNote: (id, access) => trail.readNote(id, access),
    readAnswer: (id, access) => trail.readAnswer(id, access),
    writeSessionMessage: (params) => messages.writeSessionMessage(params),
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
