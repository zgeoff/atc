export type RestoreLane = 'local' | 'remote';

export interface RestoreLaneReport {
  readonly lane: RestoreLane;
  readonly terminals: number;
  readonly attached: number;
  readonly started: number;
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
