import type { Config } from '@atc/config';
import type { AgentID } from '@atc/core';
import { ansi } from '@atc/core';
import type { DaemonBoot } from '@atc/protocol';
import type { DaemonClient } from '@atc/protocol/client';
import type { ClientMode } from './build-client-machine';
import { collectSessionRows } from './collect-session-rows';
import { collectTargetPicks } from './collect-target-picks';
import type { DaemonLinks } from './create-daemon-links';
import type { FleetMirror } from './create-fleet-mirror';
import { formatLinkState } from './daemon-link-state';
import { resolveAgentMetadata } from './resolve-agent-metadata';
import type { AgentMetadata } from './resolve-agent-metadata';
import { isSameSessionKey } from './session-key';
import type { DaemonName, SessionKey } from './session-key';
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
  readonly links: Pick<DaemonLinks, 'clientFor' | 'stateOf' | 'listDaemons'>;
  readonly findFocusedKey: () => SessionKey | null;
  readonly getMode: () => ClientMode;
  readonly getConfirm: () => OverlayConfirm;
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

  // What the hint line shows in place of the hints until the next keypress,
  // such as why a forget kept a workspace.
  notice: string | null;

  agentLabels: Readonly<Record<AgentID, string>>;

  agentModels: Readonly<Record<AgentID, Readonly<Record<string, string>>>>;

  // How many execution targets the daemon could spawn on right now; the
  // target column appears once more than one is available.
  availableTargets: number;

  // What each remote daemon says about its agents, which the rows of that daemon's sessions read.
  readonly remoteAgents: Map<string, AgentMetadata>;

  // The sessions the list shows, sorted. A daemon other than the primary whose link is not up
  // shows none of its rows.
  readonly pickSessions: () => MirrorSession[];

  // The sessions the list may show, before sorting and filtering.
  readonly listVisible: () => MirrorSession[];

  // Draws the overlay with the confirmation the machine holds, or with the one
  // given, for a caller that runs before the machine's step settles.
  readonly render: (confirm?: OverlayConfirm) => void;

  // target availability moves as remote hosts wake and sleep, so each overlay refresh
  // rereads it rather than trusting the boot-time answer.
  readonly refreshAgents: () => Promise<void>;

  // Reads one daemon's agents through the client its link has just opened.
  readonly readAgents: (daemon: DaemonName, client: DaemonClient) => Promise<void>;

  // Runs as the overlay opens, inside the machine's step that also drops any
  // pending confirmation, so it draws without one.
  readonly open: () => void;
}

export function createOverlayScreen(deps: OverlayScreenDeps): OverlayScreen {
  const daemons = deps.links.listDaemons();
  const primary = daemons[0] ?? null;

  // The primary's rows stay, as its wait for the daemon shows elsewhere; another daemon's rows
  // wait for its link.
  const isShown = (daemon: DaemonName): boolean =>
    daemon === primary || deps.links.stateOf(daemon).kind === 'up';

  // One line for each daemon that is not the primary and whose link is not up, so a daemon never
  // reads as one with no sessions.
  const collectDaemonLines = (): string[] =>
    daemons
      .filter((daemon) => !isShown(daemon))
      .map((daemon) => formatLinkState(daemon, deps.links.stateOf(daemon)));

  const self: OverlayScreen = {
    selected: 0,
    filter: null,
    grouped: false,
    notice: null,
    agentLabels: deps.bootMetadata.labels,
    agentModels: deps.bootMetadata.models,
    availableTargets: 0,
    remoteAgents: new Map<string, AgentMetadata>(),

    listVisible: () => deps.mirror.sessions.filter((session) => isShown(session.daemon)),

    pickSessions: () =>
      collectSessionRows(self.listVisible(), {
        daemons: deps.links.listDaemons(),
        grouped: self.grouped,
        filter: self.filter,
      }),

    render: (confirm = deps.getConfirm()) => {
      const sessions = self.pickSessions();

      self.selected = Math.max(0, Math.min(self.selected, sessions.length - 1));

      drawOverlay({
        sessions,
        agentLabels: self.agentLabels,
        agentModels: self.agentModels,
        remoteAgents: self.remoteAgents,
        showDaemon: daemons.length > 1,
        daemonLines: collectDaemonLines(),
        showTarget: self.availableTargets >= 2,
        selected: self.selected,
        confirmKill: confirm === 'kill',
        confirmDestroy: confirm === 'destroy',
        filter: self.filter,
        notice: self.notice,
        stale: deps.getBoot().stale && !deps.isDaemonRestarting(),
        grouped: self.grouped,
      });

      deps.scheduleStatus();
    },

    readAgents: async (daemon, client) => {
      try {
        const answer = await client.sendRequest('agents.list');

        const meta = resolveAgentMetadata(deps.readConfig(), answer);

        // the primary's answer also sets the target column, which follows the daemon the picker
        // spawns on.
        if (daemon === primary) {
          self.agentLabels = meta.labels;
          self.agentModels = meta.models;

          self.availableTargets = collectTargetPicks(answer).filter(
            (target) => target.available,
          ).length;
        } else if (daemon !== null) {
          self.remoteAgents.set(daemon, meta);
        }
      } catch {
        return;
      }

      if (deps.getMode() === 'overlay') {
        self.render();
      }
    },

    refreshAgents: async () => {
      await Promise.all(
        deps.links.listDaemons().map(async (daemon) => {
          const client = deps.links.clientFor(daemon);

          if (client !== null) {
            await self.readAgents(daemon, client);
          }
        }),
      );
    },

    open: () => {
      self.filter = null;
      void self.refreshAgents();
      const focused = deps.findFocusedKey();

      const focusedIndex = self
        .pickSessions()
        .findIndex((session) => focused !== null && isSameSessionKey(session, focused));

      self.selected = Math.max(0, focusedIndex);

      process.stdout.write(ansi.resetInputModes + ansi.clear);
      self.render('none');
    },
  };

  return self;
}
