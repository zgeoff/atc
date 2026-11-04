// The boot queue a restored session waits in: the sessions whose harness
// runs on the daemon's own machine, or those on remote hosts.
export type RestoreLane = 'local' | 'remote';

// What one lane's terminals did during a restore.
export interface RestoreLaneReport {
  readonly lane: RestoreLane;
  readonly terminals: number;

  // The terminals that attached to an agent their host still ran, which
  // reports no start.
  readonly attached: number;

  readonly started: number;

  // The time from the restore's start to the lane's last reported start;
  // null when no agent reported one.
  readonly lastStartMs: number | null;
}

export function formatRestoreReport(restored: number, lanes: readonly RestoreLaneReport[]): string {
  const parts = lanes.map((report) => {
    const lastStart =
      report.lastStartMs === null ? 'none' : `${(report.lastStartMs / 1000).toFixed(1)}s`;

    return `${report.lane}: terminals ${report.terminals}, attached ${report.attached}, started ${report.started}, last start ${lastStart}`;
  });

  return `atc restored the fleet (${[`registered ${restored}`, ...parts].join('; ')})`;
}
