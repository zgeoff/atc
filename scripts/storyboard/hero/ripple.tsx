import { CUT_S, UNIT_S } from './constants.ts';
import { getColor } from './kit.ts';
import type { TokenName } from './kit.ts';
import { Track } from './track.tsx';
import type { When } from './when.ts';

interface RippleProps {
  readonly x: number;
  readonly y: number;
  readonly when: When;
  readonly tone: TokenName;
  readonly radius?: number;
  readonly flatness?: number;
  readonly lengthUnits?: number;
}

// A flat ring that spreads over the ground and fades.
export function Ripple(props: RippleProps) {
  const radius = props.radius ?? 46;
  const flatness = props.flatness ?? 0.5;
  const lengthS = (props.lengthUnits ?? 0.07) * UNIT_S;

  return (
    <ellipse
      cx={props.x}
      cy={props.y}
      rx={4}
      ry={2}
      fill="none"
      stroke={getColor(props.tone)}
      stroke-width={2.2}
      opacity={0}
    >
      <Track
        when={props.when}
        attribute="rx"
        keys={[
          [0, 4],
          [lengthS, radius],
        ]}
      />
      <Track
        when={props.when}
        attribute="ry"
        keys={[
          [0, 4 * flatness],
          [lengthS, radius * flatness],
        ]}
      />
      <Track
        when={props.when}
        attribute="opacity"
        keys={[
          [-CUT_S, 0],
          [0, 1],
          [lengthS, 0],
        ]}
      />
    </ellipse>
  );
}
