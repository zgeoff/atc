import { writeFileSync } from 'node:fs';
import { spawn } from 'bun-pty';
import type { IPty } from 'bun-pty';
import type { AdapterEvent, AgentAdapter, AgentID } from './agent-adapter';
import type { AgentSessionID } from './agent-session-id';
import { collectCleanEnv } from './collect-clean-env';
import { socketPath, statusFile } from './config';
import type { FleetEntry, FleetStore } from './fleet-entry';
import type { HookEvent } from './hooks';
import { resolveRepoRoot } from './resolve-repo-root';
import type { SessionID } from './session-id';

export type SessionState = 'running' | 'needs_you' | 'done' | 'exited';

export type SessionEventKind = 'added' | 'state' | 'renamed' | 'removed';

// The over-the-wire view of a session: everything but the PTY handle, plus
// the surface kind.
export interface SessionDescriptor {
  readonly id: SessionID;
  readonly name: string;
  readonly cwd: string;
  readonly state: SessionState;
  readonly unread: boolean;
  readonly lastMsg: string;
  readonly lastDetail?: string;
  readonly agentSessionID?: AgentSessionID;
  readonly agent: AgentID;
  readonly pinned: boolean;
  readonly lastAttachedAt: number;
  readonly repoRoot: string;
  readonly namedBy: 'user' | 'auto' | 'agent';
  readonly createdAt: number;
  readonly kind: 'pty' | 'headless';
  readonly alive: boolean;

  // Whether this session's agent can run a headless turn, so the client can
  // offer the eject action without knowing which agent it is.
  readonly canEject: boolean;
}

export interface Session {
  id: SessionID;
  name: string;
  cwd: string;
  kind: 'pty' | 'headless';
  pty: IPty | null;
  state: SessionState;
  unread: boolean;
  lastMsg: string;
  lastDetail?: string;
  agentSessionID?: AgentSessionID;
  agent: AgentID;
  transcriptSource?: string;
  pinned: boolean;

  // when the operator last attached, so lists can lead with the sessions
  // they were just working in; starts at creation time.
  lastAttachedAt: number;

  // the repository this session's directory belongs to (the directory
  // itself outside any repository), for clustering in the overlay.
  repoRoot: string;

  // who last named this session: the agent's own rename beats everything, a
  // user-typed spawn name beats auto-summaries.
  namedBy: 'user' | 'auto' | 'agent';
  createdAt: number;
}

let counter = 0;

export class SessionManager {
  sessions: Session[] = [];

  focusedId: SessionID | null = null;

  onOutput: (s: Session, data: string) => void = () => {};

  onChange: () => void = () => {};

  onEvent: (kind: SessionEventKind, s: Session) => void = () => {};

  // Whether any registered adapter has a screen detector, decided once at
  // construction since the registry never changes afterward. Lets a hot path
  // that only cares about this answer skip walking live sessions to find it.
  readonly hasScreenDetector: boolean;

  private readonly adapters: Readonly<Record<AgentID, AgentAdapter>>;

  private readonly store: FleetStore;

  private readonly statusPath: string;

  constructor(
    fallback: AgentAdapter,
    store: FleetStore,
    statusPath: string | undefined = statusFile,
    adapters: readonly AgentAdapter[] = [],
  ) {
    // Each adapter names the id it answers to, so a registry key can never
    // disagree with the adapter behind it. A later one wins the id.
    this.adapters = Object.fromEntries([fallback, ...adapters].map((a) => [a.id, a]));
    this.hasScreenDetector = Object.values(this.adapters).some((a) => a.screenDetector !== null);
    this.store = store;
    this.statusPath = statusPath ?? statusFile;
  }

  /**
   * Adapter registered under this id, or null when there is none. Lookup
   * never falls back to another id: a session whose agent is not registered
   * is unsupported, not somebody else's spawn.
   */
  findAdapter(id: AgentID): AgentAdapter | null {
    return this.adapters[id] ?? null;
  }

  // Hands a live terminal session off to a headless run: the terminal dies,
  // the record lives on as a headless session and keeps its screen history.
  yankHeadless(id: SessionID): Session | null {
    const s = this.sessions.find((x) => x.id === id);

    if (!s || s.pty === null || s.agentSessionID === undefined) {
      return null;
    }

    const pty = s.pty;

    s.pty = null;
    s.kind = 'headless';
    s.state = 'running';
    s.lastMsg = 'ejected to headless';

    pty.kill();
    this.onEvent('state', s);
    this.emitChange();

    return s;
  }

  // Registers a fleet entry as a session with no terminal yet, so a
  // fleet-wide restore can show every incoming session at once; adopting it
  // later attaches the terminal. Exited entries come back as killed
  // sessions: still listed and revivable, never auto-adopted.
  restore(entry: FleetEntry): Session {
    const exited = entry.exited === true;

    // An entry whose agent is no longer registered still gets its row, so a
    // backend dropped from the config shows as itself instead of vanishing or
    // reviving under another agent. Adopting a terminal for it is refused.
    let lastMsg = 'waiting to restore';

    if (exited) {
      lastMsg = 'killed';
    } else if (this.findAdapter(entry.agent) === null) {
      lastMsg = `no adapter for '${entry.agent}'`;
    }

    const session: Session = {
      // oxlint-disable-next-line no-unsafe-type-assertion -- this is where atc mints a session id
      id: `s${++counter}-${Date.now().toString(36)}` as SessionID,
      name: entry.name,
      cwd: entry.cwd,
      kind: 'headless',
      pty: null,
      state: exited ? 'exited' : 'running',
      unread: false,
      lastMsg,
      agentSessionID: entry.agentSessionID,
      agent: entry.agent,
      pinned: entry.pinned ?? false,
      lastAttachedAt: entry.lastAttachedAt ?? Date.now(),
      repoRoot: resolveRepoRoot(entry.cwd),
      namedBy: 'auto',
      createdAt: Date.now(),
    };

    this.sessions.push(session);
    this.writeStatus();
    this.onEvent('added', session);

    return session;
  }

  // Adopts a headless session back into a terminal: a fresh PTY resumes the
  // same agent session id.
  adoptTerminal(id: SessionID, cols: number, rows: number): Session | null {
    const s = this.sessions.find((x) => x.id === id);

    if (!s || s.pty !== null || s.agentSessionID === undefined) {
      return null;
    }

    const adapter = this.findAdapter(s.agent);

    if (adapter === null) {
      return null;
    }

    const plan = adapter.planSpawn({ prompt: '', resume: s.agentSessionID });

    const pty = spawn(plan.bin, plan.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: s.cwd,
      env: collectCleanEnv({ ATC_SESSION_ID: s.id, ATC_SOCKET: socketPath }),
    });

    s.pty = pty;
    s.kind = 'pty';
    s.state = 'running';
    s.lastMsg = 'revived';

    pty.onData((d) => {
      this.onOutput(s, d);
    });

    pty.onExit(() => {
      s.pty = null;

      if (s.kind === 'pty' && s.state !== 'exited') {
        s.state = 'exited';
        s.unread = this.focusedId !== s.id;
        s.lastMsg = 'process exited';
      }

      this.onEvent('state', s);
      this.emitChange();
    });

    void this.writeFleet();
    this.onEvent('state', s);
    this.emitChange();

    return s;
  }

  /**
   * Renames and/or pins a session on a caller's behalf. A rename lands at
   * user strength, so auto-summaries stop overwriting it while an
   * in-session rename still wins. Pinned sessions lead every list.
   */
  updateSession(id: SessionID, name?: string, pinned?: boolean): boolean {
    const s = this.sessions.find((x) => x.id === id);

    if (s === undefined) {
      return false;
    }

    if (name !== undefined && name !== '' && s.namedBy !== 'agent') {
      s.name = name;
      s.namedBy = 'user';

      this.onEvent('renamed', s);
    }

    if (pinned !== undefined && pinned !== s.pinned) {
      s.pinned = pinned;

      this.onEvent('state', s);
    }

    void this.writeFleet();
    this.writeStatus();
    this.emitChange();

    return true;
  }

  updateSurfaceState(id: SessionID, state: SessionState, msg: string) {
    const s = this.sessions.find((x) => x.id === id);

    if (!s || s.kind !== 'headless') {
      return;
    }

    s.state = state;
    s.lastMsg = msg;
    s.unread = this.focusedId !== s.id;

    this.onEvent('state', s);
    this.emitChange();
  }

  // The detector-stack screen tier reports through here: only flips between
  // running and needs_you — hook-driven done/exited states always win.
  updateAttention(id: SessionID, state: 'needs_you' | 'running', msg: string) {
    const s = this.sessions.find((x) => x.id === id);

    if (!s || s.pty === null || s.state === state) {
      return;
    }

    if (s.state !== 'running' && s.state !== 'needs_you') {
      return;
    }

    s.state = state;
    s.lastMsg = msg;

    if (state === 'needs_you') {
      s.unread = this.focusedId !== s.id;
    }

    this.onEvent('state', s);
    this.emitChange();
  }

  get focused(): Session | null {
    return this.sessions.find((s) => s.id === this.focusedId) ?? null;
  }

  // resume: true opens the agent's own session picker; an agent session id
  // resumes that specific session (fleet restore).
  spawn(
    cwd: string,
    name: string,
    prompt: string,
    cols: number,
    rows: number,
    resume: boolean | AgentSessionID = false,
    namedBy: 'user' | 'auto' = 'auto',
    agent: AgentID = 'claude',
  ): Session {
    const adapter = this.findAdapter(agent);

    if (adapter === null) {
      throw new Error(`no adapter for agent '${agent}'`);
    }

    // oxlint-disable-next-line no-unsafe-type-assertion -- this is where atc mints a session id
    const id = `s${++counter}-${Date.now().toString(36)}` as SessionID;
    const plan = adapter.planSpawn({ prompt, resume });

    const pty = spawn(plan.bin, plan.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: collectCleanEnv({ ATC_SESSION_ID: id, ATC_SOCKET: socketPath }),
    });

    let initialMsg = prompt;

    if (initialMsg === '') {
      initialMsg = resume === false ? 'started' : 'adopting…';
    }

    const session: Session = {
      id,
      name,
      cwd,
      kind: 'pty',
      pty,
      state: 'running',
      unread: false,
      lastMsg: initialMsg,
      ...(typeof resume === 'string' ? { agentSessionID: resume } : {}),
      agent,
      pinned: false,
      lastAttachedAt: Date.now(),
      repoRoot: resolveRepoRoot(cwd),
      namedBy,
      createdAt: Date.now(),
    };

    pty.onData((d) => {
      this.onOutput(session, d);
    });

    pty.onExit(() => {
      session.pty = null;

      // A session mid-handoff keeps its headless state; the terminal dying
      // is expected there, not an exit.
      if (session.kind === 'pty' && session.state !== 'exited') {
        session.state = 'exited';
        session.unread = this.focusedId !== session.id;
        session.lastMsg = 'process exited';
      }

      this.onEvent('state', session);
      this.emitChange();
    });

    this.sessions.push(session);
    void this.writeFleet();
    this.writeStatus();
    this.onEvent('added', session);

    return session;
  }

  collectDescriptors(): SessionDescriptor[] {
    return this.sessions.map((s) => ({
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      state: s.state,
      unread: s.unread,
      lastMsg: s.lastMsg,
      ...(s.lastDetail === undefined ? {} : { lastDetail: s.lastDetail }),
      ...(s.agentSessionID === undefined ? {} : { agentSessionID: s.agentSessionID }),
      agent: s.agent,
      pinned: s.pinned,
      lastAttachedAt: s.lastAttachedAt,
      repoRoot: s.repoRoot,
      namedBy: s.namedBy,
      createdAt: s.createdAt,
      kind: s.kind,
      alive: s.pty !== null || (s.kind === 'headless' && s.state !== 'exited'),
      canEject: (this.findAdapter(s.agent)?.headlessRunner ?? null) !== null,
    }));
  }

  // Returns the normalized event kind so the caller can key lifecycle
  // bookkeeping on it, or null when no session or adapter matches.
  applyHook(e: HookEvent): AdapterEvent['kind'] | null {
    const s = this.sessions.find((x) => x.id === e.atcId);

    if (!s) {
      return null;
    }

    const adapter = this.findAdapter(s.agent);

    if (adapter === null) {
      return null;
    }

    const ev = adapter.normalizeHook(e);

    // Reporters belong to the terminal process; once a session is headless,
    // late reports from the dying terminal must not clobber its state.
    if (s.kind === 'headless') {
      return ev.kind;
    }

    const focused = this.focusedId === s.id;
    let dirty = false;

    if (ev.agentSessionID !== undefined && s.agentSessionID !== ev.agentSessionID) {
      s.agentSessionID = ev.agentSessionID;
      void this.writeFleet();
      dirty = true;
    }

    if (ev.detail !== undefined) {
      s.lastDetail = ev.detail;
    }

    if (ev.transcriptSource !== undefined) {
      s.transcriptSource = ev.transcriptSource;
    }

    if (ev.nameSource !== undefined) {
      void this.refreshName(s, ev.nameSource);
    }

    switch (ev.kind) {
      case 'started': {
        if (s.lastMsg === 'adopting…') {
          s.lastMsg = 'adopted';
          dirty = true;
        }

        break;
      }
      case 'needs-input': {
        s.state = 'needs_you';
        s.unread = !focused;
        s.lastMsg = ev.message ?? 'needs input';
        dirty = true;
        break;
      }
      case 'turn-done': {
        s.state = 'done';
        s.unread = !focused;
        s.lastMsg = 'turn done';
        dirty = true;
        break;
      }
      case 'prompt-submitted': {
        s.state = 'running';
        s.unread = false;
        s.lastMsg = ev.message ?? 'working';
        dirty = true;
        break;
      }

      // A live terminal can report an end without dying — resuming claude
      // closes the superseded session while its process stays interactive.
      // Exited is reserved for a gone terminal; onExit owns that transition.
      case 'ended': {
        if (s.pty === null) {
          s.state = 'exited';
        }

        s.unread = false;
        s.lastMsg = 'session ended';
        dirty = true;
        break;
      }

      // Heartbeats only matter for the agent-session-id capture above.
      case 'heartbeat': {
        break;
      }
    }

    if (dirty) {
      this.onEvent('state', s);
      this.emitChange();
    }

    return ev.kind;
  }

  private async refreshName(s: Session, source: string) {
    const adapter = this.findAdapter(s.agent);

    if (adapter === null) {
      return;
    }

    const update = await adapter.loadName(source, s.namedBy);

    if (update === null || update.name === '' || update.name === s.name) {
      return;
    }

    s.name = update.name;

    if (update.namedBy !== undefined) {
      s.namedBy = update.namedBy;
    }

    void this.writeFleet();
    this.onEvent('renamed', s);
    this.emitChange();
  }

  // Shell command that re-opens this session outside atc (or anywhere).
  buildResumeCommand(id: SessionID): string | null {
    const s = this.sessions.find((x) => x.id === id);

    if (!s) {
      return null;
    }

    return this.findAdapter(s.agent)?.buildResumeCommand(s.cwd, s.agentSessionID) ?? null;
  }

  attach(id: SessionID) {
    const s = this.sessions.find((x) => x.id === id);

    if (!s) {
      return;
    }

    s.unread = false;
    s.lastAttachedAt = Date.now();
    void this.writeFleet();

    // Attaching answers the attention request: a still-pending prompt
    // re-flags it via the next notification.
    if (s.state === 'needs_you') {
      s.state = 'running';
      s.lastMsg = 'attached';
    }

    this.onEvent('state', s);
    this.emitChange();
  }

  ack(id: SessionID) {
    const s = this.sessions.find((x) => x.id === id);

    if (s) {
      s.unread = false;

      this.onEvent('state', s);
    }

    this.emitChange();
  }

  // A kill's response is the caller's cue that the session is safely
  // archived, so the write it depends on must land before that response
  // goes out.
  async kill(id: SessionID): Promise<void> {
    const s = this.sessions.find((x) => x.id === id);

    if (!s) {
      return;
    }

    if (s.pty) {
      s.pty.kill();

      s.pty = null;
      s.state = 'exited';
      s.lastMsg = 'killed';

      this.onEvent('state', s);
    } else {
      this.sessions = this.sessions.filter((x) => x.id !== id);

      if (this.focusedId === id) {
        this.focusedId = null;
      }

      this.onEvent('removed', s);
    }

    await this.writeFleet();

    this.emitChange();
  }

  killAll() {
    for (const s of this.sessions) {
      s.pty?.kill();
    }
  }

  private emitChange() {
    this.writeStatus();
    this.onChange();
  }

  // Consumed by the injected statusline command so wrangled sessions render
  // fleet state inside their own status line.
  writeStatus() {
    const c = this.countStates();
    const urgent = this.sortSessions().find((s) => s.state === 'needs_you');

    try {
      writeFileSync(this.statusPath, JSON.stringify({ ...c, urgent: urgent?.name ?? null }));
    } catch {}
  }

  // Persisted continuously so a crash (or quit) leaves a restorable fleet.
  // Deliberate kills rewrite the file; unexpected session/atc deaths do not,
  // so the last known fleet survives for `R` restore. Sessions whose
  // terminal is gone persist as exited entries, so the killed archive
  // survives a daemon restart too.
  async writeFleet(): Promise<void> {
    const fleet: FleetEntry[] = [];

    for (const s of this.sessions) {
      if (s.agentSessionID === undefined) {
        continue;
      }

      const live = s.pty !== null || (s.kind === 'headless' && s.state !== 'exited');

      fleet.push({
        name: s.name,
        cwd: s.cwd,
        agentSessionID: s.agentSessionID,
        agent: s.agent,
        ...(s.pinned ? { pinned: true } : {}),
        lastAttachedAt: s.lastAttachedAt,
        ...(live ? {} : { exited: true }),
      });
    }

    await this.store.writeFleet(fleet);
  }

  countStates() {
    return countSessionStates(this.sessions);
  }

  sortSessions(): Session[] {
    return sortSessionViews(this.sessions);
  }
}

export function countSessionStates(
  list: readonly { readonly state: SessionState }[],
): Record<SessionState, number> {
  const c = { needs_you: 0, running: 0, done: 0, exited: 0 };

  for (const s of list) {
    c[s.state]++;
  }

  return c;
}

interface SortableSessionView {
  readonly state: SessionState;
  readonly pinned: boolean;
  readonly lastAttachedAt: number;
  readonly createdAt: number;
}

// Overlay order: pinned sessions first in most-recently-attached order, then
// everyone else by urgency — who needs you, finished turns, busy, dead —
// with most-recently-attached breaking ties inside each state.
export function sortSessionViews<T extends SortableSessionView>(list: readonly T[]): T[] {
  const rank: Record<SessionState, number> = {
    needs_you: 0,
    done: 1,
    running: 2,
    exited: 3,
  };

  return [...list].toSorted((a, b) => {
    if (a.pinned !== b.pinned) {
      return a.pinned ? -1 : 1;
    }

    const recency = b.lastAttachedAt - a.lastAttachedAt || b.createdAt - a.createdAt;

    return a.pinned ? recency : rank[a.state] - rank[b.state] || recency;
  });
}

// Never a filesystem path, so a repository can't collide with it.
export const PINNED_GROUP_KEY = ' pinned';

// Overlay display order for the grouped view: the flat sort with each
// repository's sessions pulled together at the position of its best-ranked
// member, so the renderer's adjacency-based headers appear once per group.
// Pinned sessions form their own leading group.
export function sortGroupedSessionViews<
  T extends SortableSessionView & { readonly repoRoot: string },
>(list: readonly T[]): T[] {
  const buckets = new Map<string, T[]>();

  for (const s of sortSessionViews(list)) {
    const key = s.pinned ? PINNED_GROUP_KEY : s.repoRoot;
    const bucket = buckets.get(key);

    if (bucket === undefined) {
      buckets.set(key, [s]);
    } else {
      bucket.push(s);
    }
  }

  return [...buckets.values()].flat();
}
