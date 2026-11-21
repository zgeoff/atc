interface ColumnWants {
  // the widest content of each column in the rows, 0 for a column no row fills
  readonly name: number;
  readonly daemon: number;
  readonly place: number;
  readonly repo: number;
  readonly agent: number;
}

export interface ColumnInput {
  // the columns from the first mark to the last character a row may use
  readonly contentWidth: number;
  readonly isNarrow: boolean;
  readonly showDaemon: boolean;
  readonly showRepo: boolean;
  readonly wants: ColumnWants;
}

// A width of 0 hides the column.
export interface ColumnPlan {
  readonly name: number;
  readonly daemon: number;
  readonly place: number;
  readonly repo: number;
  readonly agent: number;
  readonly message: number;
  readonly age: number;
}

// the bar, the state glyph and the gap after them
const ROW_PREFIX_WIDTH = 3;

export const COLUMN_GAP = 2;
const AGE_WIDTH = 4;
const MIN_MESSAGE = 12;
const MIN_NAME = 8;
const CAPS = { name: 24, daemon: 10, place: 14, repo: 16, agent: 8 };

// The widths of the columns for one panel width; the message takes what the others leave. Below a
// dozen for it, the agent, repository, place and daemon drop out in turn, and the name shrinks to
// 8. With no room left, the age drops out and the name shrinks to what is left.
export function planListColumns(input: ColumnInput): ColumnPlan {
  const widths = {
    name: Math.min(CAPS.name, Math.max(MIN_NAME, input.wants.name)),
    daemon: input.isNarrow || !input.showDaemon ? 0 : Math.min(CAPS.daemon, input.wants.daemon),
    place: input.isNarrow ? 0 : Math.min(CAPS.place, input.wants.place),
    repo: input.isNarrow || !input.showRepo ? 0 : Math.min(CAPS.repo, input.wants.repo),
    agent: input.isNarrow ? 0 : Math.min(CAPS.agent, input.wants.agent),
  };

  let age = AGE_WIDTH;

  const spareFor = (): number => {
    const shown = Object.values(widths).filter((width) => width > 0).length;

    return (
      input.contentWidth -
      ROW_PREFIX_WIDTH -
      (age > 0 ? age + COLUMN_GAP : 0) -
      Object.values(widths).reduce((sum, width) => sum + width, 0) -
      shown * COLUMN_GAP
    );
  };

  for (const key of ['agent', 'repo', 'place', 'daemon'] as const) {
    if (spareFor() >= MIN_MESSAGE) {
      break;
    }

    widths[key] = 0;
  }

  while (spareFor() < MIN_MESSAGE && widths.name > MIN_NAME) {
    widths.name -= 1;
  }

  if (spareFor() < 0) {
    age = 0;
  }

  while (spareFor() < 0 && widths.name > 0) {
    widths.name -= 1;
  }

  return { ...widths, message: Math.max(0, spareFor()), age };
}
