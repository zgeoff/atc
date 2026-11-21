import { countSessionStates, sortSessionViews } from '@atc/protocol';
import type { DaemonBoot } from '@atc/protocol';
import type { DaemonName } from '../fleet/session-key';
import type { MirrorSession } from '../fleet/to-mirror-session';
import { drawStatusBar, eraseStatusBar } from '../terminal/draw-status-bar';

export interface StatusSchedulerDeps {
  readonly primaryName: DaemonName;
  readonly leaderLabel: string;
  readonly getBoot: () => DaemonBoot;
  readonly findFocused: () => MirrorSession | null;
  readonly listVisible: () => readonly MirrorSession[];
  readonly isAttachedLinkDown: () => boolean;

  // true while a session shows, or the session list is open over one
  readonly isOverSession: () => boolean;

  // true while the session list is open, which has no status bar of its own to show
  readonly isListOpen: () => boolean;
  readonly isDaemonRestarting: () => boolean;
  readonly isDaemonWaiting: () => boolean;

  readonly findNotice: () => string | null;

  // the fleet bar depends on what the status draws, so a frame follows each pass
  readonly requestFrame: () => void;
}

export function createStatusScheduler(deps: StatusSchedulerDeps): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let isBarDrawn = false;

  return () => {
    if (timer !== null) {
      return;
    }

    timer = setTimeout(() => {
      timer = null;

      deps.requestFrame();

      const notice = deps.findNotice();
      const isOverAttached = deps.isOverSession() && !deps.isAttachedLinkDown();

      // Over a session, and under the session list, the last row stays blank, except for a notice.
      if ((isOverAttached || deps.isListOpen()) && notice === null) {
        if (isBarDrawn) {
          eraseStatusBar();
        }

        isBarDrawn = false;

        return;
      }

      isBarDrawn = true;

      const focused = deps.findFocused();
      const visible = deps.listVisible();
      const urgent = sortSessionViews(visible).find((session) => session.state === 'needs_you');

      drawStatusBar({
        counts: countSessionStates(visible),
        focusedName: focused === null ? null : focused.name,
        urgentName: urgent === undefined ? null : urgent.name,
        leaderLabel: deps.leaderLabel,
        stale: deps.getBoot().stale,
        restarting: deps.isDaemonRestarting(),
        waiting: deps.isDaemonWaiting() || deps.isAttachedLinkDown(),
        daemonName: deps.primaryName,
        notice,
      });
    }, 50);
  };
}
