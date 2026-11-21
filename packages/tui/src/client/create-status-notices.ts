import type { Clock } from '@zgeoff/std';

const STATUS_NOTICE_MS = 8000;

export interface StatusNoticesDeps {
  readonly clock: Pick<Clock, 'schedule'>;

  // the status draws the notice, so it runs after each change
  readonly scheduleStatus: () => void;
}

export interface StatusNotices {
  readonly read: () => string | null;
  readonly show: (text: string) => void;

  // a notice that belongs to home, which the next opening of the list drops
  readonly showHome: (text: string) => void;
  readonly dropHome: () => void;
}

// The one notice the TUI shows for a while, such as a failed call or a kept folder.
export function createStatusNotices(deps: StatusNoticesDeps): StatusNotices {
  let notice: string | null = null;
  let cancel: (() => void) | null = null;
  let homeNotice: string | null = null;

  const show = (text: string) => {
    notice = text;
    cancel?.();

    cancel = deps.clock.schedule(() => {
      notice = null;
      cancel = null;

      deps.scheduleStatus();
    }, STATUS_NOTICE_MS);

    deps.scheduleStatus();
  };

  return {
    read: () => notice,
    show,

    showHome: (text) => {
      homeNotice = text;

      show(text);
    },

    dropHome: () => {
      if (homeNotice !== null && notice === homeNotice) {
        cancel?.();
        notice = null;
        cancel = null;
      }

      homeNotice = null;
    },
  };
}
