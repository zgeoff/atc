import { CUT_S } from './constants.ts';
import { Track } from './track.tsx';
import type { When } from './when.ts';

// A window of an element that is shown from one instant to another. A window with no start is shown
// from the first frame, and one with no end runs to the reset.
export type Window = readonly [from: When | undefined, to: When | undefined];

export function isShownAtStart(windows: readonly Window[]): boolean {
  return windows[0]?.[0] === undefined;
}

interface WindowsProps {
  readonly windows: readonly Window[];
}

// The windows' opacity, for an element that sets opacity 1 when its first window has no start and
// 0 otherwise.
export function Windows(props: WindowsProps) {
  return props.windows.map(([from, to]) => (
    <>
      {from === undefined ? null : (
        <Track
          when={from}
          attribute="opacity"
          keys={[
            [0, 0],
            [CUT_S, 1],
          ]}
        />
      )}
      {to === undefined ? null : (
        <Track
          when={to}
          attribute="opacity"
          keys={[
            [0, 1],
            [CUT_S, 0],
          ]}
        />
      )}
    </>
  ));
}
