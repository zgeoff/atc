export interface HomeNoticeSource {
  // the daemon's name when it is not the default one
  readonly daemonName: string | null;
  readonly notice: string | null;
  readonly isWaiting: boolean;
  readonly isRestarting: boolean;
  readonly isStale: boolean;
}

// The lines home shows for what the status bar carried: the daemon's name, the TUI's notice, then the state of the
// daemon when it is not plain.
export function collectHomeNotices(source: HomeNoticeSource): string[] {
  const notices = [
    ...(source.daemonName === null ? [] : [`@${source.daemonName}`]),
    ...(source.notice === null ? [] : [source.notice]),
  ];

  if (source.isWaiting) {
    return [...notices, '⟳ waiting for daemon'];
  }

  if (source.isRestarting) {
    return [...notices, '⟳ restarting daemon'];
  }

  return source.isStale ? [...notices, '⟳ update ready'] : notices;
}
