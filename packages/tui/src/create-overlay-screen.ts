import type { Config } from '@atc/config';
import type { AgentID } from '@atc/core';
import { ansi } from '@atc/core';
import { sortGroupedSessionViews, sortSessionViews } from '@atc/protocol';
import type { DaemonBoot } from '@atc/protocol';
import type { DaemonClient } from '@atc/protocol/client';
import type { ClientMode } from './build-client-machine';
import { collectTargetPicks } from './collect-target-picks';
import type { FleetMirror } from './create-fleet-mirror';
import { findFuzzyScore, formatDir } from './dirs';
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
  readonly readConfig: () => Config;
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
export interface OverlayScreen {
  selected: number;

  // fzf-style overlay search: null when inactive, the pattern while active.
  filter: string | null;

  // Flat list by default; g toggles clustering under repository headers.
  grouped: boolean;

  agentLabels: Readonly<Record<AgentID, string>>;

  agentModels: Readonly<Record<AgentID, Readonly<Record<string, string>>>>;

  // How many execution targets the daemon could spawn on right now; the
  // target column appears once more than one is available.
  availableTargets: number;

  readonly pickSessions: () => MirrorSession[];

  // Draws the overlay with the confirmation the machine holds, or with the one
  // given, for a caller that runs before the machine's step settles.
  readonly render: (confirm?: OverlayConfirm) => void;

  // target availability moves as remote hosts wake and sleep, so each overlay refresh
  // rereads it rather than trusting the boot-time answer.
  readonly refreshAgents: () => Promise<void>;

  // Runs as the overlay opens, inside the machine's step that also drops any
  // pending confirmation, so it draws without one.
  readonly open: () => void;
}

export function createOverlayScreen(deps: OverlayScreenDeps): OverlayScreen {
  const self: OverlayScreen = {
    selected: 0,
    filter: null,
    grouped: false,
    agentLabels: deps.bootMetadata.labels,
    agentModels: deps.bootMetadata.models,
    availableTargets: 0,

    pickSessions: () => {
      const fleet = deps.mirror.sessions;
      const sorted = self.grouped ? sortGroupedSessionViews(fleet) : sortSessionViews(fleet);

      if (self.filter === null || self.filter === '') {
        return sorted;
      }

      const query = self.filter;

      const matched = new Set(
        sorted
          .filter(
            (session) =>
              findFuzzyScore(`${session.name} ${formatDir(session.cwd)}`, query) !== null,
          )
          .map((session) => session.id),
      );

      // A matching sub-session keeps its parent row, so it stays nested.
      return sorted.filter(
        (session) =>
          matched.has(session.id) ||
          sorted.some((child) => child.parent === session.id && matched.has(child.id)),
      );
    },

    render: (confirm = deps.getConfirm()) => {
      const sessions = self.pickSessions();

      self.selected = Math.max(0, Math.min(self.selected, sessions.length - 1));

      drawOverlay({
        sessions,
        agentLabels: self.agentLabels,
        agentModels: self.agentModels,
        showTarget: self.availableTargets >= 2,
        selected: self.selected,
        confirmKill: confirm === 'kill',
        confirmDestroy: confirm === 'destroy',
        filter: self.filter,
        stale: deps.getBoot().stale && !deps.isDaemonRestarting(),
        grouped: self.grouped,
      });

      deps.scheduleStatus();
    },

    refreshAgents: async () => {
      try {
        const answer = await deps.getClient().sendRequest('agents.list');

        const meta = resolveAgentMetadata(deps.readConfig(), answer);

        self.agentLabels = meta.labels;
        self.agentModels = meta.models;

        self.availableTargets = collectTargetPicks(answer).filter(
          (target) => target.available,
        ).length;
      } catch {
        return;
      }

      if (deps.getMode() === 'overlay') {
        self.render();
      }
    },

    open: () => {
      self.filter = null;
      void self.refreshAgents();

      const focusedIndex = self
        .pickSessions()
        .findIndex((session) => session.id === deps.findFocusedID());

      self.selected = Math.max(0, focusedIndex);

      process.stdout.write(ansi.resetInputModes + ansi.clear);
      self.render('none');
    },
  };

  return self;
}
