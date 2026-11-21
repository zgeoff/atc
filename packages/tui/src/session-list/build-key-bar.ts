import { measureWidth } from '../terminal/measure-width';
import type { OverlaySessionView } from './types';

export interface KeyBarItem {
  readonly key: string;
  readonly label: string;
}

export const KEY_BAR_GAP = 3;

// The keys the last line offers for the selected row, as many as fit from the left. A dead session
// has no `K`, so `X end` takes its place.
export function buildKeyBar(
  selected: Readonly<OverlaySessionView> | undefined,
  width: number,
): KeyBarItem[] {
  const items = pickKeys(selected);
  const kept: KeyBarItem[] = [];
  let used = 0;

  for (const item of items) {
    const next =
      used + (kept.length === 0 ? 0 : KEY_BAR_GAP) + measureWidth(`${item.key} ${item.label}`);

    if (next > width) {
      break;
    }

    kept.push(item);

    used = next;
  }

  return kept;
}

function pickKeys(selected: Readonly<OverlaySessionView> | undefined): KeyBarItem[] {
  if (selected === undefined) {
    return [
      { key: 'n', label: 'new' },
      { key: '?', label: 'keys' },
    ];
  }

  const isHeadlessLive = selected.kind === 'headless' && selected.alive;
  const isLive = selected.alive;

  return [
    ...(isLive && !isHeadlessLive ? [{ key: '⏎', label: 'attach' }] : []),
    ...(isHeadlessLive ? [{ key: 'P', label: 'reattach' }] : []),
    ...(!isLive && selected.resumable ? [{ key: 'P', label: 'revive' }] : []),
    { key: '/', label: 'filter' },
    { key: 'f', label: 'jump' },
    { key: 'p', label: 'pin' },
    ...(isLive ? [{ key: 'K', label: 'kill' }] : []),
    { key: 'X', label: 'end' },
    { key: 'n', label: 'new' },
    { key: 'i', label: 'home' },
    { key: '?', label: 'keys' },
  ];
}
