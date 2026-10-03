import { basename, isAbsolute } from 'node:path';
import type { AgentAdapter, AgentID, SpawnOptions, SpawnOverrides } from '../agents/agent-adapter';
import { DaemonError } from '../protocol/daemon-error';
import { DAEMON_FEATURES } from '../protocol/daemon-features';
import { decodeCursor } from '../protocol/decode-cursor';
import { encodeCursor } from '../protocol/encode-cursor';
import { OutboundQueue } from '../protocol/outbound-queue';
import type { SocketWriter } from '../protocol/outbound-queue';
import { parseRequestParams } from '../protocol/parse-request-params';
import {
  MAX_CHUNK,
  MAX_LINE,
  PROTOCOL_V,
  decodeMessage,
  encodeMessage,
} from '../protocol/protocol';
import type { ErrorCode, EventMsg, RequestMsg } from '../protocol/protocol';
import type { SpawnWorkspaceSource } from '../protocol/request-param-schemas';
import type { TargetConfigError } from '../shared/collect-targets';
import type { DaemonID } from '../shared/daemon-id';
import type { MessageID } from '../shared/message-id';
import { isRecord } from '../shared/report';
import type { SessionID } from '../shared/session-id';
import { toSessionID } from '../shared/to-session-id';
import type { FleetEntry } from '../store/fleet-entry';
import type { MessageRecord } from '../store/message-record';
import type { checkRepositoryAccess } from '../workspace/check-repository-access';
import type { collectGitHubRepos } from '../workspace/collect-github-repos';
import type { Dims } from './attach-registry';
import type { AgentEntry } from './build-agent-list';
import type { FleetEvent } from './build-fleet-events';
import { buildPayloadHash } from './build-payload-hash';
import type { ReportView } from './build-report-view';
import { buildScopedContext } from './build-scoped-context';
import type { TargetEntry } from './build-target-list';
import type { KeyedRequest } from './idempotency-ledger';
import type { TranscriptPage, TranscriptPosition } from './load-transcript-page';
import { parseSpawnOverrides } from './parse-spawn-overrides';
import type { AnswerResult } from './permission-registry';
import type { ScreenText } from './screen-model';
import type { SessionDescriptor } from './sessions';
import type { TargetAccess, TargetGrant } from './target-access';

export interface SpawnParams {
  readonly cwd: string;
  readonly name: string;
  readonly prompt: string;
  readonly cols: number;
  readonly rows: number;
  readonly resume: SpawnOptions['resume'];
  readonly namedBy: 'user' | 'auto';
  readonly agent: AgentID;
  readonly parent: SessionID | null;
  readonly overrides: SpawnOverrides;
  readonly target: string;

  // Where the session's working directory comes from; null runs the
  // session in cwd as it stands.
  readonly workspace: SpawnWorkspaceSource | null;
}

interface SessionRecord {
  readonly session: SessionDescriptor;
  readonly prompt: string | null;
  readonly lastActivityAt: number;
  readonly pending: { readonly message: string } | null;
  readonly result: string | null;
}

// A transcript page with the file it came from, so a cursor into a replaced
// transcript is distinguishable from one into a grown transcript.
/**
 * What `session.forget` answers: the token a forget that destroys a host
 * must carry, with the time it stops being taken; or the forgotten session,
 * with whether its host was destroyed.
 */
type ForgetResult =
  | { readonly confirmToken: string; readonly expiresAt: number }
  | { readonly forgotten: true; readonly destroyed: boolean };

interface SessionTranscriptRead {
  readonly path: string;
  readonly page: TranscriptPage;
}

export interface DaemonContext {
  readonly build: string;
  readonly daemonID: DaemonID;
  readonly collectSessions: () => SessionDescriptor[];
  readonly collectSpawnDirs: () => Promise<string[]>;
  readonly collectAgents: () => AgentList;
  readonly collectFleet: () => Promise<FleetEntry[]>;
  readonly loadLastUsedAgent: () => Promise<AgentID>;
  readonly findAdapter: (id: AgentID) => AgentAdapter | null;

  // The targets a principal may use.
  readonly buildTargetAccess: (principal: string) => TargetAccess;

  // The target and identity a session is bound to, or null when no
  // session holds the id.
  readonly findSessionGrant: (id: SessionID) => TargetGrant | null;

  // The identity a target holds now, or null when the config holds no such
  // target.
  readonly findTargetIdentity: (target: string) => string | null;

  // The ids of a session's sub-sessions.
  readonly collectChildIDs: (id: SessionID) => SessionID[];

  // The session a permission request belongs to, answered or not, or null
  // for an unknown request.
  readonly findPermissionSession: (request: string) => SessionID | null;

  // The target a spawn runs on: the one it names, else the default. Throws
  // the refusal for a target the spawn cannot run on, and for a spawn
  // without a target when the config gives no default.
  readonly resolveSpawnTarget: (requested: string | undefined) => string;

  // Throws the refusal for a target that cannot materialize a workspace:
  // one whose provider cannot both transfer an archive and run a command.
  readonly requireWorkspaceTarget: (target: string) => void;

  // Lists a GitHub owner's repositories through gh on the daemon's host;
  // null lists the configured owner, else the gh account's own.
  readonly collectGitHubRepos: (owner: string | null) => ReturnType<typeof collectGitHubRepos>;

  // Checks that the daemon's host can read a git workspace source, and
  // resolves its ref, the way a workspace spawn from it would.
  readonly checkRepositoryAccess: typeof checkRepositoryAccess;

  // Runs the plan, which throws the refusal for a spawn it refuses, then
  // spawns. Answers with the `session.spawn` ok payload, which a keyed
  // retry replays as the first spawn answered it while the access, when
  // there is one, still reaches the target the spawn's session was bound to.
  readonly spawnSession: (
    plan: () => SpawnParams,
    keyed: KeyedRequest | null,
    access: TargetAccess | null,
  ) => Promise<Readonly<Record<string, unknown>>>;
  readonly killSession: (id: SessionID) => Promise<boolean>;

  // Forgets a session, or answers with the token a forget that destroys a
  // host must carry. Throws the refusal for a token it does not take.
  readonly forgetSession: (
    id: SessionID,
    confirmToken: string | undefined,
  ) => Promise<ForgetResult | 'missing'>;
  readonly updateSession: (id: SessionID, name?: string, pinned?: boolean) => boolean | 'child_pin';
  readonly quitDaemon: () => void;
  readonly ackSession: (id: SessionID) => boolean;
  readonly buildResumeCommand: (id: SessionID) => string | null;
  readonly readSessionScreen: (id: SessionID) => Promise<ScreenText | 'missing' | 'no_screen'>;
  readonly answerPermission: (request: string, decision: string) => AnswerResult;
  readonly restoreFleet: (cols: number, rows: number) => Promise<number>;
  readonly attachSession: (
    client: OutputClient,
    sessionID: SessionID,
    dims: Dims,
  ) => 'ok' | 'missing' | 'dead';
  readonly detachSession: (client: OutputClient, sessionID: SessionID) => void;
  readonly detachClient: (client: OutputClient) => void;
  readonly writeSessionInput: (
    sessionID: SessionID,
    data: string,
  ) => 'busy' | 'ok' | 'missing' | 'dead';

  // Types a line into the session and submits it the way the session's
  // agent accepts a line, as opposed to the raw bytes the input write takes.
  readonly writeSessionLine: (
    sessionID: SessionID,
    text: string,
  ) => 'busy' | 'ok' | 'missing' | 'dead';
  readonly ejectSession: (
    id: SessionID,
    prompt: string,
  ) => 'ok' | 'missing' | 'unsupported' | 'no_transcript';
  readonly adoptSession: (
    id: SessionID,
    cols: number,
    rows: number,
  ) => Promise<'ok' | 'missing' | 'no_transcript'>;
  readonly resizeSession: (client: OutputClient, sessionID: SessionID, dims: Dims) => boolean;
  readonly resyncClient: (sessionID: SessionID, client: OutputClient) => Promise<void>;
  readonly queueBytes?: number;
  readonly getEffectiveDims: (sessionID: SessionID) => Dims;
  readonly readSessionRecord: (id: SessionID) => Promise<SessionRecord | 'missing'>;
  readonly loadSessionTranscript: (
    id: SessionID,
    from: TranscriptPosition | null,
    limit: number,
  ) => Promise<SessionTranscriptRead | 'missing' | 'unsupported'>;

  // Reads the trail, leaving out each event of a session outside the access
  // when there is one.
  readonly readEvents: (
    afterID: number | null,
    limit: number,
    waitMs: number,
    sessionID: SessionID | null,
    access: TargetAccess | null,
  ) => Promise<EventsPage>;

  // One report by the trail id of its event, or null for a trail id that
  // holds no report, or whose report's session is outside the access when
  // there is one.
  readonly readReport: (id: number, access: TargetAccess | null) => Promise<ReportView | null>;

  // Answers with the `session.message` ok payload, which a keyed retry
  // replays with the message's current status, or with the refusal.
  readonly writeSessionMessage: (
    sessionID: SessionID,
    from: string,
    text: string,
    keyed: KeyedRequest | null,
  ) => Promise<Readonly<Record<string, unknown>> | MessageRefusal>;
  readonly readMessage: (messageID: MessageID, waitMs: number) => Promise<MessageView | null>;
  readonly attachTap: (client: TapClient, sessionID: SessionID) => 'ok' | 'missing' | 'unsupported';
  readonly ackMessage: (
    client: TapClient,
    sessionID: SessionID,
    messageID: MessageID,
  ) => Promise<MessageRecord | 'not_tapping' | 'unknown'>;
}

// The slice of a connection the attach bookkeeping needs: identity plus the
// ability to receive output events.
export interface OutputClient {
  readonly sendOutput: (sessionID: SessionID, event: EventMsg, byteLength: number) => void;
}

// The `agents.list` answer: the host the daemon runs on, each agent, each
// execution target, what a spawn without either runs with, a digest of
// the target config, and the target config problems the daemon started
// with.
interface AgentList {
  readonly daemon: {
    readonly hostname: string;
    readonly platform: string;
    readonly arch: string;
    readonly build: string;
  };
  readonly agents: readonly AgentEntry[];
  readonly targets: readonly TargetEntry[];
  readonly spawnDefaults: { readonly agent: AgentID; readonly target: string | null };
  readonly configRevision: string;
  readonly targetErrors: readonly TargetConfigError[];
}

// One `events.read` answer: the events, and whether more follow them.
interface EventsPage {
  readonly events: readonly FleetEvent[];
  readonly more: boolean;
}

// One message as `message.get` reports it: the session it belongs to now,
// every field of the record, and the other messages its turn answered.
interface MessageView {
  readonly session: SessionID;
  readonly record: MessageRecord;
  readonly answeredWith: readonly MessageID[];
}

// Why a session refuses a message before the daemon accepts it.
export type MessageRefusal = 'missing' | 'dead' | 'unsupported' | 'no_tap';

// The slice of a connection a tap subscription needs.
export interface TapClient {
  readonly sendEvent: (event: EventMsg) => void;
}

// The targets a request may use and the namespace of its idempotency keys.
interface RequestScope {
  readonly access: TargetAccess;
  readonly keyNamespace: string;
}

// The requests that act on the whole daemon, which only its owner may make.
const OWNER_METHODS: ReadonlySet<string> = new Set(['daemon.quit', 'fleet.restore']);

interface PeerSocket extends SocketWriter {
  readonly end: () => void;
}

export class DaemonConnection {
  private readonly peer: PeerSocket;

  private readonly ctx: DaemonContext;

  private readonly queue: OutboundQueue;

  private buffer = '';

  private readonly decoder = new TextDecoder();

  private helloed = false;

  // The handshake answer is written before any other response on this
  // connection, even though building it reads the store: a request that
  // arrives while that read is in flight waits behind it.
  private helloAnswered: Promise<void> = Promise.resolve();

  private readonly desynced = new Map<SessionID, number>();

  // The principal the whole connection acts as, from its handshake, and the
  // targets that principal may use; null for the daemon's owner, whose
  // reach has no limit.
  private principal: string | null = null;

  private access: TargetAccess | null = null;

  // The sessions and permission requests this limited connection was shown,
  // so the events that end them reach it after the session is gone.
  private readonly shown = new Set<string>();

  constructor(peer: PeerSocket, ctx: DaemonContext) {
    this.peer = peer;
    this.ctx = ctx;

    this.queue = new OutboundQueue(peer, ctx.queueBytes);
  }

  /**
   * Ends the connection. Safe to call more than once.
   */
  dispose(): void {
    this.peer.end();
  }

  sendEvent(event: EventMsg): void {
    if (!this.helloed || !this.canSeeEvent(event)) {
      return;
    }

    if (!this.queue.send(encodeMessage(event))) {
      this.peer.end();
    }
  }

  // Output is droppable: an overflow discards this session's backlog for
  // this client and resynchronizes with a repaint once the queue drains. An
  // intermediate chunk is never dropped without that resync, because a byte
  // stream cut mid-escape corrupts the client's terminal state.
  sendOutput(sessionID: SessionID, event: EventMsg, byteLength: number): void {
    if (!this.helloed) {
      return;
    }

    const dropped = this.desynced.get(sessionID);

    if (dropped !== undefined) {
      this.desynced.set(sessionID, dropped + byteLength);

      return;
    }

    if (!this.queue.send(encodeMessage(event))) {
      this.desynced.set(sessionID, byteLength);
    }
  }

  // Decodes with state kept across reads, so a multi-byte character split
  // between two reads decodes whole.
  // oxlint-disable-next-line prefer-readonly-parameter-types -- a socket read buffer has no readonly form
  decodeChunk(buf: Uint8Array): string {
    return this.decoder.decode(buf, { stream: true });
  }

  applyChunk(chunk: string): void {
    const buffered = this.buffer + chunk;

    if (buffered.length > MAX_LINE) {
      this.sendErr(0, 'bad_args', `line exceeds ${MAX_LINE} bytes`);
      this.peer.end();

      return;
    }

    const lines = buffered.split('\n');

    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.trim() === '') {
        continue;
      }

      if (!this.applyLine(line)) {
        this.peer.end();

        return;
      }
    }
  }

  drain(): void {
    this.queue.drain();

    if (this.queue.queuedBytes > 0 || this.desynced.size === 0) {
      return;
    }

    for (const [sessionID, dropped] of this.desynced) {
      this.desynced.delete(sessionID);
      this.sendEvent({ v: PROTOCOL_V, ev: 'SessionDesync', s: sessionID, dropped });
      void this.ctx.resyncClient(sessionID, this);
    }
  }

  // false: the connection is beyond recovery and gets closed.
  private applyLine(line: string): boolean {
    const decoded = decodeMessage(line);

    if (decoded.kind === 'malformed') {
      this.sendErr(0, 'bad_args', `malformed line: ${decoded.reason}`);

      return false;
    }

    if (decoded.kind !== 'request') {
      this.sendErr(0, 'bad_args', 'only requests flow client to daemon');

      return false;
    }

    const req = decoded.msg;

    if (req.m === 'daemon.hello') {
      return this.applyHello(req);
    }

    if (!this.helloed) {
      this.sendErr(req.id, 'unauthorized', 'daemon.hello must be the first request');

      return false;
    }

    const scope = this.findRequestScope(req);

    if (scope !== null && OWNER_METHODS.has(req.m)) {
      this.sendErr(req.id, 'unauthorized', `${req.m} is open to the daemon's owner only`);

      return true;
    }

    const ctx =
      scope === null ? this.ctx : buildScopedContext(this.ctx, scope.access, scope.keyNamespace);

    this.answerAsync(req.id, () => this.applyRequest(req, ctx));

    return true;
  }

  // The targets a request may use and the namespace its idempotency keys
  // live in: the request's own principal, limited to what the connection's
  // may use, else the connection's. Null is the daemon's owner. The owner
  // may act as any principal, that principal's keys included; a connection
  // that acts as a principal always keeps its own keys, whatever principal
  // a request acts as.
  private findRequestScope(req: RequestMsg): RequestScope | null {
    if (req.as === undefined) {
      return this.principal === null || this.access === null
        ? null
        : { access: this.access, keyNamespace: `client:${this.principal}` };
    }

    const access = this.ctx.buildTargetAccess(req.as);

    if (this.principal === null || this.access === null) {
      return { access, keyNamespace: `client:${req.as}` };
    }

    return { access: this.access.merge(access), keyNamespace: `client:${this.principal}` };
  }

  // Whether this connection may see an event: always for the daemon's
  // owner, and otherwise only for an event of a session the connection may
  // see or was already shown.
  private canSeeEvent(event: EventMsg): boolean {
    if (this.access === null) {
      return true;
    }

    const sessionID = findEventSession(event);
    const request = typeof event['request'] === 'string' ? event['request'] : null;

    if (sessionID === null) {
      return request !== null && this.shown.has(`request:${request}`);
    }

    const grant = this.ctx.findSessionGrant(sessionID);

    if (grant === null || !this.access.canUse(grant)) {
      return this.shown.has(`session:${sessionID}`);
    }

    this.shown.add(`session:${sessionID}`);

    if (request !== null) {
      this.shown.add(`request:${request}`);
    }

    return true;
  }

  // A store query that rejects must end one request, never the daemon: a
  // floating promise here would take the whole process down with it. A
  // rejection that carries a protocol error code answers with that code.
  private answerAsync(id: number, answered: () => Promise<void>): void {
    void (async () => {
      try {
        await answered();
      } catch (error) {
        if (error instanceof DaemonError) {
          this.sendErr(id, error.code, error.message, error.data);

          return;
        }

        const reason = error instanceof Error ? error.message : String(error);

        this.sendErr(id, 'internal', reason);
      }
    })();
  }

  private async applyRequest(req: RequestMsg, ctx: DaemonContext): Promise<void> {
    await this.helloAnswered;

    switch (req.m) {
      case 'daemon.ping': {
        this.sendOk(req.id, {});

        return;
      }
      case 'session.list': {
        this.sendOk(req.id, { sessions: ctx.collectSessions() });

        return;
      }
      case 'agents.list': {
        this.sendOk(req.id, { ...ctx.collectAgents() });

        return;
      }
      case 'dirs.list': {
        this.sendOk(req.id, { dirs: await ctx.collectSpawnDirs() });

        return;
      }
      case 'fleet.list': {
        this.sendOk(req.id, { fleet: await ctx.collectFleet() });

        return;
      }
      case 'repos.list': {
        await this.applyReposList(req, ctx);

        return;
      }
      case 'repos.probe': {
        await this.applyReposProbe(req, ctx);

        return;
      }
      case 'session.spawn': {
        await this.applySpawn(req, ctx);

        return;
      }
      case 'daemon.quit': {
        this.sendOk(req.id, {});
        ctx.quitDaemon();

        return;
      }
      case 'session.update': {
        const parsed = parseRequestParams('session.update', req.p);

        if (!parsed.ok) {
          this.sendErr(req.id, 'bad_args', parsed.message);

          return;
        }

        const sessionID = parsed.data.session;
        const updated = ctx.updateSession(sessionID, parsed.data.name, parsed.data.pinned);

        if (updated === 'child_pin') {
          this.sendErr(
            req.id,
            'bad_args',
            `session '${sessionID}' is a sub-session and takes its pin from its parent`,
          );
        } else if (updated) {
          this.sendOk(req.id, {});
        } else {
          this.sendErr(req.id, 'no_such_session', `no session '${sessionID}'`);
        }

        return;
      }
      case 'session.kill': {
        await this.applySessionVerb(req, 'session.kill', ctx.killSession);

        return;
      }
      case 'session.ack': {
        await this.applySessionVerb(req, 'session.ack', ctx.ackSession);

        return;
      }
      case 'session.forget': {
        const parsed = parseRequestParams('session.forget', req.p);

        if (!parsed.ok) {
          this.sendErr(req.id, 'bad_args', parsed.message);

          return;
        }

        const id = parsed.data.session;

        const forgotten = await this.ctx.forgetSession(id, parsed.data.confirmToken);

        if (forgotten === 'missing') {
          this.sendErr(req.id, 'no_such_session', `no session '${id}'`);
        } else {
          this.sendOk(req.id, { ...forgotten });
        }

        return;
      }
      case 'session.resumeCommand': {
        const parsed = parseRequestParams('session.resumeCommand', req.p);

        if (!parsed.ok) {
          this.sendErr(req.id, 'bad_args', parsed.message);

          return;
        }

        const id = parsed.data.session;
        const command = ctx.buildResumeCommand(id);

        if (command === null) {
          this.sendErr(req.id, 'no_such_session', `no session '${id}'`);
        } else {
          this.sendOk(req.id, { command });
        }

        return;
      }
      case 'session.screen': {
        const parsed = parseRequestParams('session.screen', req.p);

        if (!parsed.ok) {
          this.sendErr(req.id, 'bad_args', parsed.message);

          return;
        }

        const id = parsed.data.session;

        const screen = await ctx.readSessionScreen(id);

        if (screen === 'missing') {
          this.sendErr(req.id, 'no_such_session', `no session '${id}'`);
        } else if (screen === 'no_screen') {
          this.sendErr(req.id, 'session_dead', `session '${id}' has no captured screen`);
        } else {
          this.sendOk(req.id, { ...screen });
        }

        return;
      }
      case 'session.eject': {
        const parsed = parseRequestParams('session.eject', req.p);

        if (!parsed.ok) {
          this.sendErr(req.id, 'bad_args', parsed.message);

          return;
        }

        const sessionID = parsed.data.session;
        const result = ctx.ejectSession(sessionID, parsed.data.prompt);

        if (result === 'ok') {
          this.sendOk(req.id, {});
        } else if (result === 'unsupported') {
          this.sendErr(req.id, 'unsupported', "this session's agent has no headless handoff");
        } else if (result === 'no_transcript') {
          this.sendErr(
            req.id,
            'session_dead',
            'nothing to resume yet — the session has no saved transcript',
          );
        } else {
          this.sendErr(
            req.id,
            'no_such_session',
            `session '${sessionID}' has no live terminal with a captured agent session id`,
          );
        }

        return;
      }
      case 'session.adopt': {
        const parsed = parseRequestParams('session.adopt', req.p);

        if (!parsed.ok) {
          this.sendErr(req.id, 'bad_args', parsed.message);

          return;
        }

        const sessionID = parsed.data.session;

        const adoptResult = await ctx.adoptSession(sessionID, parsed.data.cols, parsed.data.rows);

        if (adoptResult === 'ok') {
          this.sendOk(req.id, {});
        } else if (adoptResult === 'no_transcript') {
          this.sendErr(
            req.id,
            'session_dead',
            'nothing to resume yet — the session has no saved transcript',
          );
        } else {
          this.sendErr(
            req.id,
            'no_such_session',
            `session '${sessionID}' is not a dead or headless session with a captured agent session id`,
          );
        }

        return;
      }
      case 'session.attach': {
        this.applyAttach(req, ctx);

        return;
      }
      case 'session.detach': {
        const parsed = parseRequestParams('session.detach', req.p);

        if (!parsed.ok) {
          this.sendErr(req.id, 'bad_args', parsed.message);

          return;
        }

        ctx.detachSession(this, parsed.data.session);
        this.sendOk(req.id, {});

        return;
      }
      case 'session.input': {
        this.applyInput(req, ctx);

        return;
      }
      case 'session.submit': {
        this.applySubmit(req, ctx);

        return;
      }
      case 'session.resize': {
        this.applyResize(req, ctx);

        return;
      }
      case 'permission.respond': {
        this.applyPermissionRespond(req, ctx);

        return;
      }
      case 'session.message': {
        await this.applySessionMessage(req, ctx);

        return;
      }
      case 'session.tap': {
        this.applyTap(req, ctx);

        return;
      }
      case 'message.get': {
        await this.applyMessageGet(req, ctx);

        return;
      }
      case 'message.ack': {
        await this.applyMessageAck(req, ctx);

        return;
      }
      case 'fleet.restore': {
        const parsed = parseRequestParams('fleet.restore', req.p);

        if (!parsed.ok) {
          this.sendErr(req.id, 'bad_args', parsed.message);

          return;
        }

        this.sendOk(req.id, {
          restored: await ctx.restoreFleet(parsed.data.cols, parsed.data.rows),
        });

        return;
      }
      case 'session.get': {
        await this.applySessionGet(req, ctx);

        return;
      }
      case 'session.read': {
        await this.applySessionRead(req, ctx);

        return;
      }
      case 'events.read': {
        await this.applyEventsRead(req, ctx);

        return;
      }
      case 'report.get': {
        await this.applyReportGet(req, ctx);

        return;
      }
      default: {
        this.sendErr(req.id, 'unknown_method', `unknown method '${req.m}'`);
      }
    }
  }

  private async applySpawn(req: RequestMsg, ctx: DaemonContext): Promise<void> {
    const parsed = parseRequestParams('session.spawn', req.p);

    if (!parsed.ok) {
      this.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const data = parsed.data;

    // Every refusal is thrown from the plan, which runs only once a key is
    // claimed: a retry of a held key answers from the key without checking
    // anything again, and a refused spawn drops its claim.
    const plan = (): SpawnParams => {
      // The target goes first: a config or target problem is the cause a
      // spawn reports, ahead of any agent check that problem can skew.
      const target = ctx.resolveSpawnTarget(data.target);
      const agent: AgentID = data.agent ?? 'claude';
      const adapter = ctx.findAdapter(agent);
      const entry = ctx.collectAgents().agents.find((candidate) => candidate.id === agent);

      if (adapter === null || entry === undefined) {
        throw new DaemonError('unsupported', `no adapter for agent '${agent}'`);
      }

      // A stand-in adapter declares no binary to check, so only a profiled
      // agent's missing binary refuses the spawn.
      if (adapter.profile !== undefined && !entry.installed) {
        throw new DaemonError(
          'unsupported',
          `agent '${agent}' is registered but not installed on this host`,
        );
      }

      const overrides = parseSpawnOverrides(entry, { model: data.model, effort: data.effort });

      if (!overrides.ok) {
        throw new DaemonError(overrides.code, overrides.message);
      }

      // Checked before the spawn starts, so a target that cannot take a
      // workspace refuses it before any git command runs.
      if (data.workspace !== undefined) {
        this.ctx.requireWorkspaceTarget(target);
      }

      // A workspace is materialized at cwd on the target, which only an
      // absolute path names.
      if (data.workspace !== undefined && !isAbsolute(data.cwd)) {
        throw new DaemonError('bad_args', 'a spawn with a workspace requires an absolute cwd');
      }

      let parent: SessionID | null = null;

      if (data.parent !== undefined) {
        const owner = ctx.collectSessions().find((s) => s.id === data.parent);

        if (owner === undefined) {
          throw new DaemonError('no_such_session', `no session '${data.parent}'`);
        }

        // A sub-session spawning a sub-session of its own lands beside it,
        // so a set stays one level deep.
        parent = owner.parent ?? owner.id;
      }

      return {
        cwd: data.cwd,
        name: data.name === '' ? basename(data.cwd) : data.name,
        prompt: data.prompt,
        cols: data.cols,
        rows: data.rows,
        resume: data.resume,
        namedBy: data.name === '' ? 'auto' : 'user',
        agent,
        parent,
        overrides: overrides.overrides,
        target,
        workspace: data.workspace ?? null,
      };
    };

    const keyed =
      data.idempotencyKey === undefined
        ? null
        : { key: data.idempotencyKey, payloadHash: buildPayloadHash(data) };

    const spawned = await ctx.spawnSession(plan, keyed, null);

    this.sendOk(req.id, spawned);
  }

  // Lists repositories for a workspace spawn to the request's target, so
  // a principal lists only for a target it may spawn a workspace on.
  private async applyReposList(req: RequestMsg, ctx: DaemonContext): Promise<void> {
    const parsed = parseRequestParams('repos.list', req.p);

    if (!parsed.ok) {
      this.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    this.ctx.requireWorkspaceTarget(ctx.resolveSpawnTarget(parsed.data.target));

    const listed = await ctx.collectGitHubRepos(parsed.data.owner ?? null);

    if (!listed.ok) {
      throw new DaemonError(listed.code, listed.message, { problem: listed.problem });
    }

    this.sendOk(req.id, {
      owner: listed.owner,
      repos: listed.repos,
      gitProtocol: listed.gitProtocol,
    });
  }

  // Probes a git workspace source for a spawn to the request's target, so
  // a principal probes only for a target it may spawn a workspace on.
  private async applyReposProbe(req: RequestMsg, ctx: DaemonContext): Promise<void> {
    const parsed = parseRequestParams('repos.probe', req.p);

    if (!parsed.ok) {
      this.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const data = parsed.data;

    this.ctx.requireWorkspaceTarget(ctx.resolveSpawnTarget(data.target));

    const access = await ctx.checkRepositoryAccess({
      url: data.url,
      ref: data.ref,
      sha: data.sha,
      credential: data.credentialRef,
    });

    if (!access.ok) {
      throw new DaemonError(access.code, access.message);
    }

    this.sendOk(req.id, {
      url: access.url,
      head: access.head,
      refs: access.refs,
      resolved: access.resolved,
    });
  }

  private applyAttach(req: RequestMsg, ctx: DaemonContext): void {
    const parsed = parseRequestParams('session.attach', req.p);

    if (!parsed.ok) {
      this.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const sessionID = parsed.data.session;

    const result = ctx.attachSession(this, sessionID, {
      cols: parsed.data.cols,
      rows: parsed.data.rows,
    });

    if (result === 'missing') {
      this.sendErr(req.id, 'no_such_session', `no session '${sessionID}'`);

      return;
    }

    if (result === 'dead') {
      this.sendErr(req.id, 'session_dead', `session '${sessionID}' has no live process`);

      return;
    }

    const dims = ctx.getEffectiveDims(sessionID);

    this.sendOk(req.id, { cols: dims.cols, rows: dims.rows });
  }

  private applyInput(req: RequestMsg, ctx: DaemonContext): void {
    const parsed = parseRequestParams('session.input', req.p);

    if (!parsed.ok) {
      this.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const sessionID = parsed.data.session;

    this.sendInputResult(req, sessionID, ctx.writeSessionInput(sessionID, parsed.data.d));
  }

  private applySubmit(req: RequestMsg, ctx: DaemonContext): void {
    const parsed = parseRequestParams('session.submit', req.p);

    if (!parsed.ok) {
      this.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const sessionID = parsed.data.session;

    this.sendInputResult(req, sessionID, ctx.writeSessionLine(sessionID, parsed.data.text));
  }

  private sendInputResult(
    req: RequestMsg,
    sessionID: SessionID,
    result: 'busy' | 'ok' | 'missing' | 'dead',
  ): void {
    if (result === 'missing') {
      this.sendErr(req.id, 'no_such_session', `no session '${sessionID}'`);

      return;
    }

    if (result === 'dead') {
      this.sendErr(req.id, 'session_dead', `session '${sessionID}' has no live process`);

      return;
    }

    if (result === 'busy') {
      this.sendErr(
        req.id,
        'too_slow',
        `session '${sessionID}' is mid-run; wait for the turn to end`,
      );

      return;
    }

    this.sendOk(req.id, {});
  }

  private applyResize(req: RequestMsg, ctx: DaemonContext): void {
    const parsed = parseRequestParams('session.resize', req.p);

    if (!parsed.ok) {
      this.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const sessionID = parsed.data.session;

    if (!ctx.resizeSession(this, sessionID, { cols: parsed.data.cols, rows: parsed.data.rows })) {
      this.sendErr(req.id, 'bad_args', `not attached to session '${sessionID}'`);

      return;
    }

    this.sendOk(req.id, {});
  }

  private applyPermissionRespond(req: RequestMsg, ctx: DaemonContext): void {
    const parsed = parseRequestParams('permission.respond', req.p);

    if (!parsed.ok) {
      this.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const request = parsed.data.request;
    const decision = parsed.data.decision;
    const result = ctx.answerPermission(request, decision);

    switch (result) {
      case 'ok': {
        this.sendOk(req.id, {});

        return;
      }
      case 'already_answered': {
        this.sendErr(req.id, 'already_answered', `request '${request}' was already answered`);

        return;
      }
      case 'unsupported': {
        this.sendErr(req.id, 'unsupported', `request '${request}' is answered with keystrokes`);

        return;
      }
      case 'unknown': {
        this.sendErr(req.id, 'bad_args', `unknown permission request '${request}'`);
      }
    }
  }

  private async applySessionGet(req: RequestMsg, ctx: DaemonContext): Promise<void> {
    const parsed = parseRequestParams('session.get', req.p);

    if (!parsed.ok) {
      this.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const id = parsed.data.session;

    const record = await ctx.readSessionRecord(id);

    if (record === 'missing') {
      this.sendErr(req.id, 'no_such_session', `no session '${id}'`);

      return;
    }

    this.sendOk(req.id, { ...record });
  }

  private async applySessionRead(req: RequestMsg, ctx: DaemonContext): Promise<void> {
    const parsed = parseRequestParams('session.read', req.p);

    if (!parsed.ok) {
      this.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const id = parsed.data.session;
    let from: TranscriptPosition | null = null;

    if (parsed.data.cursor !== undefined) {
      const decoded = decodeCursor(parsed.data.cursor);

      if (decoded === null || decoded.kind !== 'transcript') {
        this.sendErr(req.id, 'bad_args', `'${parsed.data.cursor}' is not a session.read cursor`);

        return;
      }

      from = { path: decoded.path, offset: decoded.offset };
    }

    const read = await ctx.loadSessionTranscript(id, from, parsed.data.limit);

    if (read === 'missing') {
      this.sendErr(req.id, 'no_such_session', `no session '${id}'`);
    } else if (read === 'unsupported') {
      this.sendErr(
        req.id,
        'unsupported',
        `session '${id}' runs an agent whose transcript atc cannot read`,
      );
    } else {
      this.sendOk(req.id, {
        rows: read.page.rows,
        cursor: encodeCursor({ kind: 'transcript', path: read.path, offset: read.page.offset }),
        more: read.page.more,
      });
    }
  }

  private async applyEventsRead(req: RequestMsg, ctx: DaemonContext): Promise<void> {
    const parsed = parseRequestParams('events.read', req.p);

    if (!parsed.ok) {
      this.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    let afterID: number | null = null;

    if (parsed.data.cursor !== undefined) {
      const decoded = decodeCursor(parsed.data.cursor);

      if (decoded === null || decoded.kind !== 'events') {
        this.sendErr(req.id, 'bad_args', `'${parsed.data.cursor}' is not an events.read cursor`);

        return;
      }

      afterID = decoded.id;
    }

    const page = await ctx.readEvents(
      afterID,
      parsed.data.limit,
      parsed.data.waitMs,
      parsed.data.session ?? null,
      null,
    );

    const last = page.events.at(-1);

    // A cursor always comes back so a client can long-poll from an empty trail.
    this.sendOk(req.id, {
      events: page.events,
      cursor: last === undefined ? encodeCursor({ kind: 'events', id: afterID ?? 0 }) : last.cursor,
      more: page.more,
    });
  }

  // A cursor that is not an events cursor, one at a row that holds no
  // report, and one at a report outside the access all get one refusal, so
  // the refusal is the same for a report out of reach and a missing one.
  private async applyReportGet(req: RequestMsg, ctx: DaemonContext): Promise<void> {
    const parsed = parseRequestParams('report.get', req.p);

    if (!parsed.ok) {
      this.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const decoded = decodeCursor(parsed.data.report);

    const view =
      decoded === null || decoded.kind !== 'events' ? null : await ctx.readReport(decoded.id, null);

    if (view === null) {
      this.sendErr(req.id, 'bad_args', `no report '${parsed.data.report}'`);

      return;
    }

    this.sendOk(req.id, { ...view });
  }

  private async applySessionMessage(req: RequestMsg, ctx: DaemonContext): Promise<void> {
    const parsed = parseRequestParams('session.message', req.p);

    if (!parsed.ok) {
      this.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const sessionID = parsed.data.session;

    const keyed =
      parsed.data.idempotencyKey === undefined
        ? null
        : { key: parsed.data.idempotencyKey, payloadHash: buildPayloadHash(parsed.data) };

    const result = await ctx.writeSessionMessage(
      sessionID,
      parsed.data.from,
      parsed.data.text,
      keyed,
    );

    if (result === 'missing') {
      this.sendErr(req.id, 'no_such_session', `no session '${sessionID}'`);

      return;
    }

    if (result === 'dead') {
      this.sendErr(req.id, 'session_dead', `session '${sessionID}' has no live process`);

      return;
    }

    if (result === 'unsupported') {
      this.sendErr(
        req.id,
        'unsupported',
        `session '${sessionID}' cannot take messages: its agent has no message tap`,
      );

      return;
    }

    if (result === 'no_tap') {
      this.sendErr(req.id, 'unsupported', `session '${sessionID}' never attached a message tap`);

      return;
    }

    this.sendOk(req.id, result);
  }

  private applyTap(req: RequestMsg, ctx: DaemonContext): void {
    const parsed = parseRequestParams('session.tap', req.p);

    if (!parsed.ok) {
      this.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const sessionID = parsed.data.session;
    const result = ctx.attachTap(this, sessionID);

    if (result === 'missing') {
      this.sendErr(req.id, 'no_such_session', `no session '${sessionID}'`);

      return;
    }

    if (result === 'unsupported') {
      this.sendErr(req.id, 'unsupported', `session '${sessionID}' cannot take messages`);

      return;
    }

    this.sendOk(req.id, {});
  }

  private async applyMessageGet(req: RequestMsg, ctx: DaemonContext): Promise<void> {
    const parsed = parseRequestParams('message.get', req.p);

    if (!parsed.ok) {
      this.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const messageID = parsed.data.message;

    const view = await ctx.readMessage(messageID, parsed.data.waitMs);

    if (view === null) {
      this.sendErr(req.id, 'bad_args', `no message '${messageID}'`);

      return;
    }

    const record = view.record;

    this.sendOk(req.id, {
      message: record.id,
      session: view.session,
      from: record.from,
      text: record.text,
      status: record.status,
      sentAt: record.sentAt,
      ...(record.deliveredAt === undefined ? {} : { deliveredAt: record.deliveredAt }),
      ...(record.answeredAt === undefined ? {} : { answeredAt: record.answeredAt }),
      ...(record.answer === undefined ? {} : { answer: record.answer }),
      turn: record.turn ?? null,
      answeredWith: view.answeredWith,
    });
  }

  private async applyMessageAck(req: RequestMsg, ctx: DaemonContext): Promise<void> {
    const parsed = parseRequestParams('message.ack', req.p);

    if (!parsed.ok) {
      this.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const sessionID = parsed.data.session;
    const messageID = parsed.data.message;

    const result = await ctx.ackMessage(this, sessionID, messageID);

    if (result === 'not_tapping') {
      this.sendErr(req.id, 'bad_args', `this connection is not tapping session '${sessionID}'`);

      return;
    }

    if (result === 'unknown') {
      this.sendErr(req.id, 'bad_args', `no message '${messageID}' for session '${sessionID}'`);

      return;
    }

    this.sendOk(req.id, { message: result.id, status: result.status });
  }

  private async applySessionVerb(
    req: RequestMsg,
    method: 'session.kill' | 'session.ack',
    verb: (id: SessionID) => boolean | Promise<boolean>,
  ): Promise<void> {
    const parsed = parseRequestParams(method, req.p);

    if (!parsed.ok) {
      this.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const id = parsed.data.session;

    const ok = await verb(id);

    if (ok) {
      this.sendOk(req.id, {});
    } else {
      this.sendErr(req.id, 'no_such_session', `no session '${id}'`);
    }
  }

  private applyHello(req: RequestMsg): boolean {
    const parsedHello = parseRequestParams('daemon.hello', req.p);
    const client = parsedHello.ok ? parsedHello.data.client : 'unknown client';

    // A principal the handshake cannot read would otherwise leave the
    // connection with the owner's reach.
    if (!parsedHello.ok && req.p?.['principal'] !== undefined) {
      this.sendErr(req.id, 'bad_args', parsedHello.message);

      return false;
    }

    const principal = parsedHello.ok ? (parsedHello.data.principal ?? null) : null;

    if (principal !== null) {
      this.principal = principal;
      this.access = this.ctx.buildTargetAccess(principal);
    }

    if (req.v !== PROTOCOL_V) {
      this.sendErr(
        req.id,
        'protocol_mismatch',
        `${client} speaks protocol v${req.v}, daemon ${this.ctx.build} speaks v${PROTOCOL_V}; restart the daemon so both run the same build`,
      );

      return false;
    }

    this.helloed = true;
    this.helloAnswered = this.sendHelloOk(req.id);

    this.answerAsync(req.id, () => this.helloAnswered);

    return true;
  }

  private async sendHelloOk(id: number): Promise<void> {
    this.sendOk(id, {
      daemon: this.ctx.build,
      daemonID: this.ctx.daemonID,
      limits: { maxLine: MAX_LINE, maxChunk: MAX_CHUNK },
      features: DAEMON_FEATURES,
      lastUsedAgent: await this.ctx.loadLastUsedAgent(),
    });
  }

  private sendOk(id: number, ok: Readonly<Record<string, unknown>>): void {
    this.queue.send(encodeMessage({ v: PROTOCOL_V, id, ok }));
  }

  private sendErr(
    id: number,
    code: ErrorCode,
    msg: string,
    data?: Readonly<Record<string, unknown>>,
  ): void {
    this.queue.send(
      encodeMessage({
        v: PROTOCOL_V,
        id,
        err: { code, msg, ...(data === undefined ? {} : { data }) },
      }),
    );
  }
}

// The session an event belongs to, from its session id or the session it
// adds, or null for an event of no session.
function findEventSession(event: EventMsg): SessionID | null {
  if (typeof event['s'] === 'string') {
    return toSessionID(event['s']);
  }

  const session = event['session'];

  if (isRecord(session) && typeof session['id'] === 'string') {
    return toSessionID(session['id']);
  }

  return null;
}
