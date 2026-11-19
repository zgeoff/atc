import type { Config } from '@atc/config';
import type { AgentID } from '@atc/core';
import { ansi } from '@atc/core';
import type { DaemonClient } from '@atc/protocol/client';
import type { ClientMode } from '../client/build-client-machine';
import type { DaemonLinks } from '../daemon-link/create-daemon-links';
import { formatLinkState } from '../daemon-link/daemon-link-state';
import { collectSessionRows } from '../fleet/collect-session-rows';
import type { FleetMirror } from '../fleet/create-fleet-mirror';
import { resolveAgentMetadata } from '../fleet/resolve-agent-metadata';
import type { AgentMetadata } from '../fleet/resolve-agent-metadata';
import { isSameSessionKey } from '../fleet/session-key';
import type { DaemonName, SessionKey } from '../fleet/session-key';
import type { MirrorSession } from '../fleet/to-mirror-session';
import { drawOverlay } from '../terminal/draw-overlay';
import { collectTargetPicks } from './collect-target-picks';

export type OverlayConfirm = 'none' | 'kill' | 'destroy';

export interface OverlayScreenDeps {
  readonly mirror: FleetMirror;
  readonly bootMetadata: AgentMetadata;
  readonly readConfig: () => Config;
  readonly links: Pick<DaemonLinks, 'clientFor' | 'stateOf' | 'listDaemons'>;
  readonly findFocusedKey: () => SessionKey | null;
  readonly getMode: () => ClientMode;
  readonly getConfirm: () => OverlayConfirm;

  readonly findConfirmKey: () => SessionKey | null;
  readonly isBootStale: () => boolean;
  readonly isDaemonRestarting: () => boolean;
  readonly scheduleStatus: () => void;
  readonly write: (chunk: string) => void;
}

export interface OverlayScreen {
  selected: number;

  filter: string | null;

  grouped: boolean;

  notice: string | null;

  agentLabels: Readonly<Record<AgentID, string>>;

  agentModels: Readonly<Record<AgentID, Readonly<Record<string, string>>>>;

  availableTargets: number;

  readonly remoteAgents: Map<string, AgentMetadata>;

  readonly pickSessions: () => MirrorSession[];

  readonly listVisible: () => MirrorSession[];

  readonly render: (confirm?: OverlayConfirm) => void;

  // target availability moves as remote hosts wake and sleep, so each overlay refresh
  // rereads it rather than trusting the boot-time answer.
  readonly refreshAgents: () => Promise<void>;

  readonly readAgents: (daemon: DaemonName, client: DaemonClient) => Promise<void>;

  readonly open: () => void;
}

export function createOverlayScreen(deps: OverlayScreenDeps): OverlayScreen {
  const daemons = deps.links.listDaemons();
  const primary = daemons[0] ?? null;

  // The primary's rows stay even while it is not up, since its wait for the daemon is shown elsewhere.
  const isShown = (daemon: DaemonName): boolean =>
    daemon === primary || deps.links.stateOf(daemon).kind === 'up';

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
      const confirmKey = confirm === 'none' ? null : deps.findConfirmKey();

      const confirmIndex = sessions.findIndex(
        (session) => confirmKey !== null && isSameSessionKey(session, confirmKey),
      );

      if (confirmIndex !== -1) {
        self.selected = confirmIndex;
      }

      self.selected = Math.max(0, Math.min(self.selected, sessions.length - 1));

      drawOverlay(
        {
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
          stale: deps.isBootStale() && !deps.isDaemonRestarting(),
          grouped: self.grouped,
        },
        deps.write,
      );

      deps.scheduleStatus();
    },

    readAgents: async (daemon, client) => {
      try {
        const answer = await client.sendRequest('agents.list');

        const meta = resolveAgentMetadata(deps.readConfig(), answer);

        // the target column follows the daemon the picker spawns on.
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

      deps.write(ansi.resetInputModes + ansi.clear);
      self.render('none');
    },
  };

  return self;
}
