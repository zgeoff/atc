import { CUT_S } from './constants.ts';
import { Track } from './track.tsx';
import type { When } from './when.ts';

interface ShowProps {
  readonly from: When;

  // Absent: shown until the reset, which the build fades out itself.
  readonly to?: When;
  readonly peak?: number;
  readonly fadeInS?: number;
  readonly fadeOutS?: number;
}

// An element, which sets opacity 0, shows from one instant to another.
export function Show(props: ShowProps) {
  const peak = props.peak ?? 1;

  return (
    <>
      <Track
        when={props.from}
        attribute="opacity"
        keys={[
          [0, 0],
          [props.fadeInS ?? CUT_S, peak],
        ]}
      />
      {props.to === undefined ? null : (
        <Track
          when={props.to}
          attribute="opacity"
          keys={[
            [-(props.fadeOutS ?? CUT_S) * 2, peak],
            [-(props.fadeOutS ?? CUT_S), 0],
          ]}
        />
      )}
    </>
  );
}
