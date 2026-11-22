import { measureWidth } from '../terminal/measure-width';
import { BAR_MARGIN } from './constants';

export interface RightEnd {
  // empty when no session needs the user, or when the count does not fit
  readonly needYouText: string;

  // empty when the label does not fit
  readonly leaderLabel: string;

  // the columns between the need-you text and the leader label
  readonly gap: number;
  readonly width: number;
}

// The right end that fits between the bar's blank end columns. Short of room, it drops the leader
// label first, then the need-you count.
export function buildRightEnd(needYou: number, leaderLabel: string, cols: number): RightEnd {
  const needYouText = formatNeedYou(needYou, cols);
  const room = cols - BAR_MARGIN * 2;
  const gap = needYouText === '' ? 0 : 3;
  const width = measureWidth(needYouText) + gap + measureWidth(leaderLabel);

  if (width <= room) {
    return { needYouText, leaderLabel, gap, width };
  }

  if (needYouText !== '' && measureWidth(needYouText) <= room) {
    return { needYouText, leaderLabel: '', gap: 0, width: measureWidth(needYouText) };
  }

  return { needYouText: '', leaderLabel: '', gap: 0, width: 0 };
}

// the width under which the right end drops the words after the count
const NARROW_COLS = 90;

function formatNeedYou(needYou: number, cols: number): string {
  if (needYou === 0) {
    return '';
  }

  return cols < NARROW_COLS ? `◆ ${needYou}` : `◆ ${needYou} need you`;
}
