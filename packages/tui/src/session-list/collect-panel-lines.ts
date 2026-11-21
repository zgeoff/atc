import type { PanelLine, PanelPlan } from './types';

export interface PlacedLine {
  readonly line: PanelLine;

  // the line's place among the list lines, or null for a line of the frame
  readonly listIndex: number | null;
}

// The panel's lines from top to bottom, leaving out each border the plan dropped.
export function collectPanelLines(plan: Readonly<PanelPlan>): PlacedLine[] {
  return [
    ...toFrameLines(plan.topBorder),
    ...plan.content.map((line, index) => ({ line, listIndex: index })),
    ...toFrameLines(plan.divider),
    ...plan.lastLines.flatMap((line) => toFrameLines(line)),
    ...toFrameLines(plan.bottomBorder),
  ];
}

function toFrameLines(line: PanelLine | null): PlacedLine[] {
  return line === null ? [] : [{ line, listIndex: null }];
}
