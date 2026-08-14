import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'bun-pty';
import type { IPty } from 'bun-pty';
import type { AgentAdapter } from './agent-adapter';
import { collectCleanEnv } from './collect-clean-env';
import { socketPath, stateDir, statusFile } from './config';
import type { HookEvent } from './hooks';
import { isRecord } from './report';

export type SessionState = 'running' | 'needs_you' | 'done' | 'exited';

export type SessionEventKind = 'added' | 'state' | 'renamed' | 'removed';

// The over-the-wire view of a session: everything but the PTY handle, plus
// the surface kind.
export interface SessionDescriptor {
  readonly id: string;
  readonly name: string;
  readonly cwd: string;
  readonly state: SessionState;
  readonly unread: boolean;
  readonly lastMsg: string;
  readonly lastDetail?: string;
  readonly claudeId?: string;
  readonly group?: string;
  readonly namedBy: 'user' | 'auto' | 'agent';
  readonly createdAt: number;
  readonly kind: 'pty' | 'jsonl';
  readonly alive: boolean;
}

export interface Session {
  id: string;
  name: string;
  cwd: string;
  kind: 'pty' | 'jsonl';
  pty: IPty | null;
  state: SessionState;
  unread: boolean;
  lastMsg: string;
  lastDetail?: string;
  claudeId?: string;
  transcriptSource?: string;
  group?: string;

  // who last named this session: the agent's own rename beats everything, a
  // user-typed spawn name beats auto-summaries.
  namedBy: 'user' | 'auto' | 'agent';
  createdAt: number;
}

let counter = 0;

export interface FleetEntry {
  readonly name: string;
  readonly cwd: string;
  readonly claudeId: string;
  readonly group?: string;
}

const fleetFile = join(stateDir, 'fleet.json');

export interface FleetStore {
  readonly loadFleet: () => FleetEntry[];
  readonly writeFleet: (entries: readonly FleetEntry[]) => void;
}

const jsonFleetStore: FleetStore = {
  loadFleet: () => loadFleet(),
  writeFleet: (entries) => {
    try {
      writeFileSync(fleetFile, JSON.stringify(entries, null, 2));
    } catch {}
  },
};

function loadFleet(): FleetEntry[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(fleetFile, 'utf8'));

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter(
      (entry): entry is FleetEntry =>
        isRecord(entry) &&
        typeof entry['name'] === 'string' &&
        typeof entry['cwd'] === 'string' &&
        typeof entry['claudeId'] === 'string',
    );
  } catch {
    return [];
  }
}

export class SessionManager {
  sessions: Session[] = [];

  focusedId: string | null = null;

  onOutput: (s: Session, data: string) => void = () => {};

  onChange: () => void = () => {};

  onEvent: (kind: SessionEventKind, s: Session) => void = () => {};

  private readonly adapter: AgentAdapter;

  private readonly store: FleetStore;

  private readonly statusPath: string;

  constructor(adapter: AgentAdapter, store: FleetStore = jsonFleetStore, statusPath = statusFile) {
    this.adapter = adapter;
    this.store = store;
    this.statusPath = statusPath;
  }

  // Hands a live terminal session off to a headless run: the terminal dies,
  // the record lives on as a jsonl session and keeps its screen history.
  yankHeadless(id: string): Session | null {
    const s = this.sessions.find((x) => x.id === id);

    if (!s || s.pty === null || s.claudeId === undefined) {
      return null;
    }

    const pty = s.pty;

    s.pty = null;
    s.kind = 'jsonl';
    s.state = 'running';
    s.lastMsg = 'ejected to headless';

    pty.kill();
    this.onEvent('state', s);
    this.emitChange();

    return s;
  }

  // Registers a fleet entry as a session with no terminal yet, so a
  // fleet-wide restore can show every incoming session at once; adopting it
  // later attaches the terminal.
  restore(entry: FleetEntry): Session {
    const session: Session = {
      id: `s${++counter}-${Date.now().toString(36)}`,
      name: entry.name,
      cwd: entry.cwd,
      kind: 'jsonl',
      pty: null,
      state: 'running',
      unread: false,
      lastMsg: 'waiting to restore',
      claudeId: entry.claudeId,
      ...(entry.group === undefined ? {} : { group: entry.group }),
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
  adoptTerminal(id: string, cols: number, rows: number): Session | null {
    const s = this.sessions.find((x) => x.id === id);

    if (!s || s.pty !== null || s.claudeId === undefined) {
      return null;
    }

    const plan = this.adapter.planSpawn({ prompt: '', resume: s.claudeId });

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

    this.writeFleet();
    this.onEvent('state', s);
    this.emitChange();

    return s;
  }

  // Reports a headless run's lifecycle into the session state machine.
  /**
   * Renames and/or regroups a session on a caller's behalf. A rename lands
   * at user strength, so auto-summaries stop overwriting it while an
   * in-session rename still wins. An empty group clears the grouping.
   */
  updateSession(id: string, name?: string, group?: string): boolean {
    const s = this.sessions.find((x) => x.id === id);

    if (s === undefined) {
      return false;
    }

    if (name !== undefined && name !== '' && s.namedBy !== 'agent') {
      s.name = name;
      s.namedBy = 'user';

      this.onEvent('renamed', s);
    }

    if (group !== undefined) {
      if (group === '') {
        delete s.group;
      } else {
        s.group = group;
      }

      this.onEvent('state', s);
    }

    this.writeFleet();
    this.writeStatus();
    this.emitChange();

    return true;
  }

  updateSurfaceState(id: string, state: SessionState, msg: string) {
    const s = this.sessions.find((x) => x.id === id);

    if (!s || s.kind !== 'jsonl') {
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
  updateAttention(id: string, state: 'needs_you' | 'running', msg: string) {
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

  // resume: true opens the agent's own session picker; a string resumes that
  // specific agent session id (fleet restore).
  spawn(
    cwd: string,
    name: string,
    prompt: string,
    cols: number,
    rows: number,
    resume: boolean | string = false,
    namedBy: 'user' | 'auto' = 'auto',
    group?: string,
  ): Session {
    const id = `s${++counter}-${Date.now().toString(36)}`;
    const plan = this.adapter.planSpawn({ prompt, resume });

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
      ...(typeof resume === 'string' ? { claudeId: resume } : {}),
      ...(group === undefined ? {} : { group }),
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
    this.writeFleet();
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
      ...(s.claudeId === undefined ? {} : { claudeId: s.claudeId }),
      ...(s.group === undefined ? {} : { group: s.group }),
      namedBy: s.namedBy,
      createdAt: s.createdAt,
      kind: s.kind,
      alive: s.pty !== null || (s.kind === 'jsonl' && s.state !== 'exited'),
    }));
  }

  applyHook(e: HookEvent) {
    const s = this.sessions.find((x) => x.id === e.atcId);

    // Reporters belong to the terminal process; once a session is headless,
    // late reports from the dying terminal must not clobber its state.
    if (!s || s.kind === 'jsonl') {
      return;
    }

    const ev = this.adapter.normalizeHook(e);
    const focused = this.focusedId === s.id;
    let dirty = false;

    if (ev.agentSessionID !== undefined && s.claudeId !== ev.agentSessionID) {
      s.claudeId = ev.agentSessionID;

      this.writeFleet();

      dirty = true;
    }

    if (ev.detail !== undefined) {
      s.lastDetail = ev.detail;
    }

    if (ev.nameSource !== undefined) {
      s.transcriptSource = ev.nameSource;
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
  }

  private async refreshName(s: Session, source: string) {
    const update = await this.adapter.loadName(source, s.namedBy);

    if (update === null || update.name === '' || update.name === s.name) {
      return;
    }

    s.name = update.name;

    if (update.namedBy !== undefined) {
      s.namedBy = update.namedBy;
    }

    this.writeFleet();
    this.onEvent('renamed', s);
    this.emitChange();
  }

  // Shell command that re-opens this session outside atc (or anywhere).
  buildResumeCommand(id: string): string | null {
    const s = this.sessions.find((x) => x.id === id);

    if (!s) {
      return null;
    }

    return this.adapter.buildResumeCommand(s.cwd, s.claudeId);
  }

  attach(id: string) {
    const s = this.sessions.find((x) => x.id === id);

    if (!s) {
      return;
    }

    s.unread = false;

    // Attaching answers the attention request: a still-pending prompt
    // re-flags it via the next notification.
    if (s.state === 'needs_you') {
      s.state = 'running';
      s.lastMsg = 'attached';
    }

    this.onEvent('state', s);
    this.emitChange();
  }

  ack(id: string) {
    const s = this.sessions.find((x) => x.id === id);

    if (s) {
      s.unread = false;

      this.onEvent('state', s);
    }

    this.emitChange();
  }

  kill(id: string) {
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

    this.writeFleet();
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
  // so the last known fleet survives for `R` restore.
  writeFleet() {
    const fleet: FleetEntry[] = [];

    for (const s of this.sessions) {
      const live = s.pty !== null || (s.kind === 'jsonl' && s.state !== 'exited');

      if (live && s.claudeId !== undefined) {
        fleet.push({
          name: s.name,
          cwd: s.cwd,
          claudeId: s.claudeId,
          ...(s.group === undefined ? {} : { group: s.group }),
        });
      }
    }

    this.store.writeFleet(fleet);
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

// Overlay order: who needs you first, then finished turns, then busy, then dead.
export function sortSessionViews<
  T extends { readonly state: SessionState; readonly createdAt: number },
>(list: readonly T[]): T[] {
  const rank: Record<SessionState, number> = {
    needs_you: 0,
    done: 1,
    running: 2,
    exited: 3,
  };

  return [...list].toSorted((a, b) => rank[a.state] - rank[b.state] || a.createdAt - b.createdAt);
}

// Overlay display order: the urgency sort with each group's sessions pulled
// together at the position of its most urgent member, so the renderer's
// adjacency-based headers appear once per group and urgent groups still lead.
export function sortGroupedSessionViews<
  T extends {
    readonly state: SessionState;
    readonly createdAt: number;
    readonly group?: string;
    readonly cwd: string;
  },
>(list: readonly T[]): T[] {
  const buckets = new Map<string, T[]>();

  for (const s of sortSessionViews(list)) {
    const key = s.group ?? s.cwd;
    const bucket = buckets.get(key);

    if (bucket === undefined) {
      buckets.set(key, [s]);
    } else {
      bucket.push(s);
    }
  }

  return [...buckets.values()].flat();
}
