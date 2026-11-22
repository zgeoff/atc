import { CUT_S, UNIT_S } from './constants.ts';
import { getColor, getURL } from './kit.ts';
import type { TokenName } from './kit.ts';
import { Track } from './track.tsx';
import type { When } from './when.ts';

interface FlashProps {
  readonly x: number;
  readonly y: number;
  readonly when: When;
  readonly tone: TokenName;
  readonly radius: number;
}

// A bright core that blinks out while a ring of the event's colour bursts outward.
export function Flash(props: FlashProps) {
  const coreS = 0.02 * UNIT_S;
  const ringS = 0.03 * UNIT_S;

  return (
    <>
      <circle
        cx={props.x}
        cy={props.y}
        r={2}
        fill={getColor('white')}
        opacity={0}
        filter={getURL('glow')}
      >
        <Track
          when={props.when}
          attribute="r"
          keys={[
            [0, 3],
            [0.006 * UNIT_S, props.radius * 0.32],
            [coreS, 2],
          ]}
        />
        <Track
          when={props.when}
          attribute="opacity"
          keys={[
            [-CUT_S, 0],
            [0, 1],
            [coreS, 0],
          ]}
        />
      </circle>
      <circle
        cx={props.x}
        cy={props.y}
        r={2}
        fill="none"
        stroke={getColor(props.tone)}
        stroke-width={3}
        opacity={0}
      >
        <Track
          when={props.when}
          attribute="r"
          keys={[
            [0, 3],
            [ringS, props.radius],
          ]}
        />
        <Track
          when={props.when}
          attribute="stroke-width"
          keys={[
            [0, 4],
            [ringS, 0.5],
          ]}
        />
        <Track
          when={props.when}
          attribute="opacity"
          keys={[
            [-CUT_S, 0],
            [0, 1],
            [ringS, 0],
          ]}
        />
      </circle>
    </>
  );
}
