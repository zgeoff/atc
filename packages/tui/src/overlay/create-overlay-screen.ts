import type { Config } from '@atc/config';
import type { AgentID } from '@atc/core';
import type { DaemonClient } from '@atc/protocol/client';
import type { ClientMode } from '../client/build-client-machine';
import type { DaemonLinks } from '../daemon-link/create-daemon-links';
import { formatLinkState } from '../daemon-link/daemon-link-state';
import type { FleetMirror } from '../fleet/create-fleet-mirror';
import { resolveAgentMetadata } from '../fleet/resolve-agent-metadata';
import type { AgentMetadata } from '../fleet/resolve-agent-metadata';
import { isSameSessionKey } from '../fleet/session-key';
import type { DaemonName, SessionKey } from '../fleet/session-key';
import type { MirrorSession } from '../fleet/to-mirror-session';
import { buildJumpPlan } from '../session-list/build-jump-plan';
import { collectListRows } from '../session-list/collect-list-rows';
import { countEndedSubSessions } from '../session-list/count-ended-sub-sessions';
import { formatListPrompt } from '../session-list/format-list-prompt';
import type { JumpState } from '../session-list/step-jump';
import type { Grouping, ListRow, OverlaySessionView, PanelInput } from '../session-list/types';

export type OverlayConfirm = 'none' | 'kill' | 'end' | 'destroy';

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
  readonly isDaemonWaiting: () => boolean;
  readonly scheduleStatus: () => void;
  readonly requestFrame: () => void;
}

export interface OverlayScreen {
  // the selected session among the rows the list shows
  selected: number;

  filter: string | null;

  grouping: Grouping;

  // jump mode, or null while it is off
  jump: JumpState | null;

  notice: string | null;

  agentLabels: Readonly<Record<AgentID, string>>;

  readonly remoteAgents: Map<string, AgentMetadata>;

  // the session rows the list shows, after the filter
  readonly pickSessions: () => MirrorSession[];

  readonly listVisible: () => MirrorSession[];

  // Selects a row by its place among `pickSessions`, and holds the session itself, so the
  // selection follows it when the rows reorder.
  readonly select: (index: number) => void;

  // The rows `pickSessions` gives, with `selected` moved onto the selected session's row, since a
  // fleet change can reorder the rows before the next frame does.
  readonly syncSelection: () => MirrorSession[];

  // the panel the list draws, for the frame at `nowMs`
  readonly readInput: (nowMs: number, spinnerFrame: number) => PanelInput;

  readonly render: () => void;

  // target availability moves as remote hosts wake and sleep, so each overlay refresh
  // rereads it rather than trusting the boot-time answer.
  readonly refreshAgents: () => Promise<void>;

  readonly readAgents: (daemon: DaemonName, client: DaemonClient) => Promise<void>;

  readonly open: () => void;
}

const DAEMON_LINE_SEPARATOR = '  ·  ';

export function createOverlayScreen(deps: OverlayScreenDeps): OverlayScreen {
  const daemons = deps.links.listDaemons();
  const primary = daemons[0] ?? null;
  let selectedKey: SessionKey | null = null;

  // The primary's rows stay even while it is not up, since its wait for the daemon is shown elsewhere.
  const isShown = (daemon: DaemonName): boolean =>
    daemon === primary || deps.links.stateOf(daemon).kind === 'up';

  const collectDaemonLines = (): string[] => [
    ...daemons
      .filter((daemon) => !isShown(daemon))
      .map((daemon) => formatLinkState(daemon, deps.links.stateOf(daemon))),
    ...(deps.isDaemonWaiting() ? ['⟳ waiting for daemon'] : []),
    ...(deps.isDaemonRestarting() ? ['⟳ restarting daemon'] : []),
  ];

  const readAgentLabel = (session: Readonly<OverlaySessionView>): string => {
    const labels =
      (session.daemon === null ? undefined : self.remoteAgents.get(session.daemon)?.labels) ??
      self.agentLabels;

    return Object.hasOwn(labels, session.agent)
      ? (labels[session.agent] ?? session.agent)
      : session.agent;
  };

  const pickRows = (): ListRow[] =>
    collectListRows(self.listVisible(), {
      grouping: self.grouping,
      filter: self.filter,
      daemons,
    });

  const moveSelectionTo = (sessions: readonly MirrorSession[], target: SessionKey | null) => {
    const targetIndex = sessions.findIndex(
      (session) => target !== null && isSameSessionKey(session, target),
    );

    if (targetIndex !== -1) {
      self.selected = targetIndex;
    }

    self.selected = Math.max(0, Math.min(self.selected, sessions.length - 1));
  };

  const self: OverlayScreen = {
    selected: 0,
    filter: null,
    grouping: deps.readConfig().list.grouping,
    jump: null,
    notice: null,
    agentLabels: deps.bootMetadata.labels,
    remoteAgents: new Map<string, AgentMetadata>(),

    listVisible: () => deps.mirror.sessions.filter((session) => isShown(session.daemon)),

    pickSessions: () => pickRows().flatMap((row) => (row.kind === 'session' ? [row.session] : [])),

    select: (index) => {
      self.selected = index;
      selectedKey = self.pickSessions()[index] ?? null;
    },

    syncSelection: () => {
      const sessions = self.pickSessions();

      moveSelectionTo(sessions, selectedKey);

      return sessions;
    },

    readInput: (nowMs, spinnerFrame) => {
      const rows = pickRows();
      const sessions = rows.flatMap((row) => (row.kind === 'session' ? [row.session] : []));
      const confirm = deps.getConfirm();
      const confirmKey = confirm === 'none' ? null : deps.findConfirmKey();

      moveSelectionTo(sessions, confirmKey ?? selectedKey);

      const subject = confirmKey === null ? undefined : deps.mirror.find(confirmKey);
      const daemonLines = collectDaemonLines();

      return {
        rows,
        selected: sessions.length === 0 ? -1 : self.selected,
        grouping: self.grouping,
        filter: self.filter,
        jump:
          self.jump === null
            ? null
            : {
                ...buildJumpPlan(
                  sessions.map((session) => session.name),
                  self.jump.typed,
                ),
                typed: self.jump.typed,
              },
        prompt:
          confirm === 'none' || subject === undefined
            ? null
            : formatListPrompt(
                confirm,
                subject,
                countEndedSubSessions(subject, deps.mirror.sessions),
              ),
        notice: self.notice,
        daemonLine: daemonLines.length === 0 ? null : daemonLines.join(DAEMON_LINE_SEPARATOR),
        updateAdvice:
          deps.isBootStale() && !deps.isDaemonRestarting()
            ? 'daemon runs an older build · u update daemon'
            : null,
        showDaemon: daemons.length > 1,
        nowMs,
        spinnerFrame,
        readAgentLabel,
      };
    },

    render: () => {
      deps.requestFrame();
    },

    readAgents: async (daemon, client) => {
      try {
        const answer = await client.sendRequest('agents.list');

        const meta = resolveAgentMetadata(deps.readConfig(), answer);

        if (daemon === primary) {
          self.agentLabels = meta.labels;
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
      self.jump = null;
      self.notice = null;
      void self.refreshAgents();
      const focused = deps.findFocusedKey();

      const focusedIndex = self
        .pickSessions()
        .findIndex((session) => focused !== null && isSameSessionKey(session, focused));

      self.select(Math.max(0, focusedIndex));
      deps.scheduleStatus();
      self.render();
    },
  };

  return self;
}
