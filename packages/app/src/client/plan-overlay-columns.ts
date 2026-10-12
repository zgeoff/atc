// The glyph, unread, and pin cells that lead every row, plus the one space
// before the first body column.
const PREFIX_WIDTH = 4;

// The last-event column's soft width once the rest has claimed its share;
// whatever width remains after shrinking goes back to it.
const EVENT_BASE_WIDTH = 4;

export interface OverlayColumnPlan {
  readonly nameWidth: number;

  // The directory column of the flat view; 0 in the grouped view and
  // whenever width pressure crowds it out.
  readonly dirWidth: number;

  // 0 while only one target is available, so the column stays hidden.
  readonly targetWidth: number;
  readonly harnessWidth: number;

  // 0 when no visible session runs an explicit model.
  readonly modelWidth: number;
  readonly lifecycleWidth: number;
  readonly eventWidth: number;
}

export interface OverlayColumnInput {
  // The width inside the overlay box: the box width less its borders and
  // padding.
  readonly innerWidth: number;

  readonly grouped: boolean;

  // Whether more than one execution target is available to spawn on.
  readonly showTarget: boolean;

  // The longest label each column would draw over the visible sessions;
  // 0 for a column with nothing to show.
  readonly targetMax: number;
  readonly harnessMax: number;
  readonly modelMax: number;
}

type ColumnKey = 'dir' | 'model' | 'event' | 'harness' | 'target' | 'name' | 'lifecycle';

// How much pressure it takes to crowd a column out, from first to go to
// last: the flat view's directory, then the model and the last event, then
// the harness, the target, and the name, with the lifecycle text held
// longest.
const SHRINK_ORDER: readonly ColumnKey[] = [
  'dir',
  'model',
  'event',
  'harness',
  'target',
  'name',
  'lifecycle',
];

const PREFERRED: Readonly<Record<ColumnKey, number>> = {
  dir: 18,
  model: 14,
  event: EVENT_BASE_WIDTH,
  harness: 14,
  target: 14,
  name: 16,
  lifecycle: 9,
};

// The least each column keeps while any width remains to take: the name,
// target, and harness stay legible after the directory, model, and last
// event have given way.
const FLOOR: Readonly<Record<ColumnKey, number>> = {
  dir: 0,
  model: 0,
  event: 0,
  harness: 3,
  target: 3,
  name: 6,
  lifecycle: 9,
};

/**
 * The column widths a session row draws with. Each column starts at the
 * shorter of its preferred width and the longest value it would draw; while
 * the row outgrows the box, the column under the least pressure that still
 * holds its floor gives up a cell at a time in the order above, so the
 * model and the last event shrink first and the name, target, and harness
 * last. Whatever width is left over after the row fits goes to the last
 * event.
 */
export function planOverlayColumns(input: Readonly<OverlayColumnInput>): OverlayColumnPlan {
  const widths: Record<ColumnKey, number> = {
    dir: input.grouped ? 0 : PREFERRED.dir,
    model: pickWidth(input.modelMax, PREFERRED.model),
    event: PREFERRED.event,
    harness: pickWidth(input.harnessMax, PREFERRED.harness),
    target: input.showTarget ? pickWidth(input.targetMax, PREFERRED.target) : 0,
    name: PREFERRED.name,
    lifecycle: PREFERRED.lifecycle,
  };

  truncateWidthsToFit(widths, input.innerWidth, (key) => FLOOR[key]);
  truncateWidthsToFit(widths, input.innerWidth, () => 0);

  // Whatever width the other columns leave, less the event column's own
  // gap, becomes the last event's width; a single spare cell is not enough
  // to bring the column back for.
  const spare = input.innerWidth - getTotalWidth({ ...widths, event: 0 });

  widths.event = spare >= 2 ? spare - 1 : 0;

  return {
    nameWidth: widths.name,
    dirWidth: widths.dir,
    targetWidth: widths.target,
    harnessWidth: widths.harness,
    modelWidth: widths.model,
    lifecycleWidth: widths.lifecycle,
    eventWidth: widths.event,
  };
}

// A column with nothing to draw keeps no width; otherwise it takes the
// shorter of its preferred width and its longest value.
function pickWidth(contentMax: number, preferred: number): number {
  return contentMax <= 0 ? 0 : Math.min(contentMax, preferred);
}

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

// The prefix plus every column and one space between the columns that still
// draw, so a column crowded to nothing takes its gap with it.
function getTotalWidth(widths: Readonly<Record<ColumnKey, number>>): number {
  const visible = SHRINK_ORDER.filter((key) => widths[key] > 0);

  return (
    PREFIX_WIDTH +
    visible.reduce((sum, key) => sum + widths[key], 0) +
    Math.max(0, visible.length - 1)
  );
}
