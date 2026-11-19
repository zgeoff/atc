import { countSessionStates, sortSessionViews } from '@atc/protocol';
import type { DaemonBoot } from '@atc/protocol';
import type { DaemonName } from '../fleet/session-key';
import type { MirrorSession } from '../fleet/to-mirror-session';
import { drawStatusBar } from '../terminal/draw-status-bar';
import type { ClientMode } from './build-client-machine';

export interface StatusSchedulerDeps {
  readonly primaryName: DaemonName;
  readonly leaderLabel: string;
  readonly getMode: () => ClientMode;
  readonly getBoot: () => DaemonBoot;
  readonly findFocused: () => MirrorSession | null;
  readonly listVisible: () => readonly MirrorSession[];
  readonly isAttachedLinkDown: () => boolean;
  readonly isDaemonRestarting: () => boolean;
  readonly isDaemonWaiting: () => boolean;

  readonly findNotice: () => string | null;
}

export function createStatusScheduler(deps: StatusSchedulerDeps): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let isNoticeOverAttached = false;

  return () => {
    if (timer !== null) {
      return;
    }

    timer = setTimeout(() => {
      timer = null;

      const notice = deps.findNotice();
      const isOverAttached = deps.getMode() === 'attached' && !deps.isAttachedLinkDown();

      if (!isOverAttached || notice !== null || isNoticeOverAttached) {
        isNoticeOverAttached = isOverAttached && notice !== null;

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
      }
    }, 50);
  };
}
