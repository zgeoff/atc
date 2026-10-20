import { loadConfig } from '@atc/config';
import type { AgentID } from '@atc/core';
import { ansi } from '@atc/core';
import { sortGroupedSessionViews, sortSessionViews } from '@atc/protocol';
import type { DaemonBoot } from '@atc/protocol';
import type { DaemonClient } from '@atc/protocol/client';
import { SHIPPED_HARNESS_PLUGINS } from '../plugins/shipped-harness-plugins';
import type { ClientMode } from './build-client-machine';
import { collectTargetPicks } from './collect-target-picks';
import { findFuzzyScore, formatDir } from './dirs';
import type { FleetMirror } from './fleet-mirror';
import { resolveAgentMetadata } from './resolve-agent-metadata';
import type { AgentMetadata } from './resolve-agent-metadata';
import type { MirrorSession } from './to-mirror-session';
import { drawOverlay } from './ui';

// The confirmation the overlay draws: none, a kill, or a forget that
// destroys the session's host.
export type OverlayConfirm = 'none' | 'kill' | 'destroy';

// What the overlay borrows from the client that owns the screen, the fleet
// mirror, and the daemon connection.
export interface OverlayScreenDeps {
  readonly mirror: FleetMirror;
  readonly bootMetadata: AgentMetadata;
  readonly findFocusedID: () => string | null;
  readonly getMode: () => ClientMode;
  readonly getConfirm: () => OverlayConfirm;
  readonly getClient: () => DaemonClient;
  readonly getBoot: () => DaemonBoot;
  readonly isDaemonRestarting: () => boolean;
  readonly scheduleStatus: () => void;
}

// The session list the leader key opens, with its selection, its search,
// and the agent and target details its rows show.
export class OverlayScreen {
  selected = 0;

  // fzf-style overlay search: null when inactive, the pattern while active.
  filter: string | null = null;

  // Flat list by default; g toggles clustering under repository headers.
  grouped = false;

  agentLabels: Readonly<Record<AgentID, string>>;

  agentModels: Readonly<Record<AgentID, Readonly<Record<string, string>>>>;

  // How many execution targets the daemon could spawn on right now; the
  // target column appears once more than one is available.
  availableTargets = 0;

  private readonly deps: OverlayScreenDeps;

  constructor(deps: OverlayScreenDeps) {
    this.deps = deps;
    this.agentLabels = deps.bootMetadata.labels;
    this.agentModels = deps.bootMetadata.models;
  }

  pickSessions(): MirrorSession[] {
    const fleet = this.deps.mirror.sessions;
    const sorted = this.grouped ? sortGroupedSessionViews(fleet) : sortSessionViews(fleet);

    if (this.filter === null || this.filter === '') {
      return sorted;
    }

    const f = this.filter;

    const matched = new Set(
      sorted
        .filter((s) => findFuzzyScore(`${s.name} ${formatDir(s.cwd)}`, f) !== null)
        .map((s) => s.id),
    );

    // A matching sub-session keeps its parent row, so it stays nested.
    return sorted.filter(
      (s) => matched.has(s.id) || sorted.some((c) => c.parent === s.id && matched.has(c.id)),
    );
  }

  // Draws the overlay with the confirmation the machine holds, or with the one
  // given, for a caller that runs before the machine's step settles.
  render(confirm: OverlayConfirm = this.deps.getConfirm()) {
    const sessions = this.pickSessions();

    this.selected = Math.max(0, Math.min(this.selected, sessions.length - 1));

    drawOverlay({
      sessions,
      agentLabels: this.agentLabels,
      agentModels: this.agentModels,
      showTarget: this.availableTargets >= 2,
      selected: this.selected,
      confirmKill: confirm === 'kill',
      confirmDestroy: confirm === 'destroy',
      filter: this.filter,
      stale: this.deps.getBoot().stale && !this.deps.isDaemonRestarting(),
      grouped: this.grouped,
    });

    this.deps.scheduleStatus();
  }

  // target availability moves as remote hosts wake and sleep, so each overlay refresh
  // rereads it rather than trusting the boot-time answer.
  async refreshAgents() {
    try {
      const answer = await this.deps.getClient().sendRequest('agents.list');

      const meta = resolveAgentMetadata(loadConfig(SHIPPED_HARNESS_PLUGINS), answer);

      this.agentLabels = meta.labels;
      this.agentModels = meta.models;
      this.availableTargets = collectTargetPicks(answer).filter((t) => t.available).length;
    } catch {
      return;
    }

    if (this.deps.getMode() === 'overlay') {
      this.render();
    }
  }

  // Runs as the overlay opens, inside the machine's step that also drops any
  // pending confirmation, so it draws without one.
  open() {
    this.filter = null;
    void this.refreshAgents();
    const focusedIndex = this.pickSessions().findIndex((s) => s.id === this.deps.findFocusedID());

    this.selected = Math.max(0, focusedIndex);

    process.stdout.write(ansi.resetInputModes + ansi.clear);
    this.render('none');
  }
}
