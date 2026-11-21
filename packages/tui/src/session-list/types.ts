import type { AgentID } from '@atc/core';
import type { SessionViewState } from '@atc/protocol';
import type { RGB } from '../compositor/types';
import type { DaemonName } from '../fleet/session-key';
import type { HarnessLifecycle, MirrorSession } from '../fleet/to-mirror-session';
import type { SessionPlace } from '../places/types';

export type Grouping = 'flat' | 'repo' | 'place';

export interface OverlaySessionView {
  readonly name: string;
  readonly cwd: string;
  readonly state: SessionViewState;
  readonly unread: boolean;
  readonly lastMsg: string;
  readonly daemon: DaemonName;
  readonly id: string;
  readonly parent: string | null;
  readonly alive: boolean;
  readonly kind: 'pty' | 'headless';
  readonly resumable: boolean;
  readonly canEject: boolean;

  // null: the daemon runs an older atc that does not send it
  readonly canDestroyHost: boolean | null;
  readonly agent: AgentID;
  readonly pinned: boolean;
  readonly repoRoot: string;
  readonly target: string;
  readonly place: SessionPlace;
  readonly model: string | null;
  readonly harness: HarnessLifecycle;

  // true while the session's machine is asleep
  readonly hostAsleep: boolean;

  // when the TUI saw the session enter its current state; null when the session was in that state
  // at the TUI's first listing
  readonly stateSince: number | null;
}

export type ListRow =
  | {
      readonly kind: 'header';
      readonly label: string;
      readonly count: number;
      readonly needYou: number;
    }
  | {
      readonly kind: 'session';
      readonly session: MirrorSession;

      // the daemon's name, set only in place mode when the row's group holds sessions from more
      // than one daemon
      readonly via: string | null;
    };

export interface PanelSpan {
  // the column from the panel's left edge
  readonly col: number;
  readonly text: string;
  readonly fg: RGB;
  readonly bold: boolean;
}

export interface PanelLine {
  readonly spans: readonly PanelSpan[];

  // true for the row that the user has selected, whose background is tinted
  readonly isSelected: boolean;
}

export interface PanelPlan {
  readonly left: number;
  readonly top: number;
  readonly width: number;

  // a border is null when the terminal has too few rows for it beside the last lines
  readonly topBorder: PanelLine | null;

  // the lines of the list, which fade in one after the other when the panel opens
  readonly content: readonly PanelLine[];
  readonly divider: PanelLine | null;

  // one line, or the several that a prompt wraps over
  readonly lastLines: readonly PanelLine[];
  readonly bottomBorder: PanelLine | null;

  // true while a visible row shows a running session, whose spinner turns
  readonly isSpinning: boolean;
}

export interface PanelInput {
  readonly rows: readonly ListRow[];

  // the selected session among the session rows, or -1
  readonly selected: number;
  readonly grouping: Grouping;
  readonly filter: string | null;

  // one label for each session row, in order, while jump mode runs
  readonly jump: { readonly labels: readonly (string | null)[]; readonly typed: string } | null;
  readonly prompt: string | null;
  readonly notice: string | null;
  readonly daemonLine: string | null;
  readonly updateAdvice: string | null;
  readonly showDaemon: boolean;
  readonly nowMs: number;
  readonly spinnerFrame: number;
  readonly readAgentLabel: (session: Readonly<OverlaySessionView>) => string;
}

export type SessionRow = Extract<ListRow, { readonly kind: 'session' }>;
