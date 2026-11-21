import type { PanelLine, PanelPlan } from '../session-list/types';
import { splitGraphemes } from '../terminal/split-graphemes';

// The text of each line of a panel, with the spans laid at their columns, for a test to read.
export function renderPanelText(plan: Readonly<PanelPlan>): string[] {
  const lines: readonly PanelLine[] = [
    plan.topBorder,
    ...plan.content,
    plan.divider,
    plan.lastLine,
    plan.bottomBorder,
  ];

  return lines.map((line) => {
    const cells: string[] = Array.from({ length: plan.width }, () => ' ');

    for (const span of line.spans) {
      let col = span.col;

      for (const grapheme of splitGraphemes(span.text)) {
        cells[col] = grapheme.text;

        if (grapheme.width === 2) {
          cells[col + 1] = '';
        }

        col += grapheme.width;
      }
    }

    return cells.join('').trimEnd();
  });
}
