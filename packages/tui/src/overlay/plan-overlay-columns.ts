const EVENT_BASE_WIDTH = 4;

export interface OverlayColumnPlan {
  readonly nameWidth: number;

  readonly dirWidth: number;

  readonly targetWidth: number;
  readonly harnessWidth: number;

  readonly modelWidth: number;
  readonly lifecycleWidth: number;
  readonly eventWidth: number;
}

export interface OverlayColumnInput {
  readonly innerWidth: number;

  readonly grouped: boolean;

  readonly showTarget: boolean;

  readonly targetMax: number;
  readonly harnessMax: number;
  readonly modelMax: number;
}

type ColumnKey = 'directory' | 'model' | 'event' | 'harness' | 'target' | 'name' | 'lifecycle';

const PREFERRED: Readonly<Record<ColumnKey, number>> = {
  directory: 18,
  model: 14,
  event: EVENT_BASE_WIDTH,
  harness: 14,
  target: 14,
  name: 16,
  lifecycle: 9,
};

const FLOOR: Readonly<Record<ColumnKey, number>> = {
  directory: 0,
  model: 0,
  event: 0,
  harness: 3,
  target: 3,
  name: 6,
  lifecycle: 9,
};

export function planOverlayColumns(input: Readonly<OverlayColumnInput>): OverlayColumnPlan {
  const widths: Record<ColumnKey, number> = {
    directory: input.grouped ? 0 : PREFERRED.directory,
    model: pickWidth(input.modelMax, PREFERRED.model),
    event: PREFERRED.event,
    harness: pickWidth(input.harnessMax, PREFERRED.harness),
    target: input.showTarget ? pickWidth(input.targetMax, PREFERRED.target) : 0,
    name: PREFERRED.name,
    lifecycle: PREFERRED.lifecycle,
  };

  truncateWidthsToFit(widths, input.innerWidth, (key) => FLOOR[key]);
  truncateWidthsToFit(widths, input.innerWidth, () => 0);

  const spare = input.innerWidth - getTotalWidth({ ...widths, event: 0 });

  widths.event = spare >= 2 ? spare - 1 : 0;

  return {
    nameWidth: widths.name,
    dirWidth: widths.directory,
    targetWidth: widths.target,
    harnessWidth: widths.harness,
    modelWidth: widths.model,
    lifecycleWidth: widths.lifecycle,
    eventWidth: widths.event,
  };
}

function pickWidth(contentMax: number, preferred: number): number {
  return contentMax <= 0 ? 0 : Math.min(contentMax, preferred);
}

const SHRINK_ORDER: readonly ColumnKey[] = [
  'directory',
  'model',
  'event',
  'harness',
  'target',
  'name',
  'lifecycle',
];

function truncateWidthsToFit(
  widths: Record<ColumnKey, number>,
  innerWidth: number,
  floorOf: (key: ColumnKey) => number,
): void {
  while (getTotalWidth(widths) > innerWidth) {
    const giver = SHRINK_ORDER.find((key) => widths[key] > floorOf(key));

    if (giver === undefined) {
      return;
    }

    widths[giver] -= 1;
  }
}

const PREFIX_WIDTH = 4;

function getTotalWidth(widths: Readonly<Record<ColumnKey, number>>): number {
  const visible = SHRINK_ORDER.filter((key) => widths[key] > 0);

  return (
    PREFIX_WIDTH +
    visible.reduce((sum, key) => sum + widths[key], 0) +
    Math.max(0, visible.length - 1)
  );
}
