import { measureWidth } from '../terminal/measure-width';

export interface RightEnd {
  // empty when no session needs the user
  readonly needYouText: string;
  readonly leaderLabel: string;

  // the columns between the need-you text and the leader label
  readonly gap: number;
  readonly width: number;
}

export function buildRightEnd(needYou: number, leaderLabel: string, cols: number): RightEnd {
  const needYouText = formatNeedYou(needYou, cols);
  const gap = needYouText === '' ? 0 : 3;

  return {
    needYouText,
    leaderLabel,
    gap,
    width: measureWidth(needYouText) + gap + measureWidth(leaderLabel),
  };
}

// the width under which the right end drops the words after the count
const NARROW_COLS = 90;

function formatNeedYou(needYou: number, cols: number): string {
  if (needYou === 0) {
    return '';
  }

  return cols < NARROW_COLS ? `◆ ${needYou}` : `◆ ${needYou} need you`;
}
