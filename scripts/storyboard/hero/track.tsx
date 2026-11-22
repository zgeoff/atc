import { Animate } from './kit.ts';
import type { When } from './when.ts';

export type TrackKey = readonly [offsetS: number, value: string | number];

interface TrackProps {
  readonly when: When;
  readonly attribute: string;
  readonly keys: readonly TrackKey[];
  readonly transform?: 'translate' | 'scale' | 'rotate';
  readonly path?: string;
}

const STEP_S = 0.5;

// One span of an animation, with its keys written as seconds from an instant of the loop.
export function Track(props: TrackProps) {
  const first = props.keys[0]?.[0] ?? 0;
  const last = props.keys.at(-1)?.[0] ?? 0;
  const lengthS = Math.max(last - first, 0.001);
  const startS = props.when.offsetS + first;

  return (
    <Animate
      attribute={props.attribute}
      at={props.when.reference}
      lead={{ steps: -startS / STEP_S }}
      span={{ steps: lengthS / STEP_S }}
      keys={props.keys.map(([offsetS, value]) => [(offsetS - first) / lengthS, value] as const)}
      {...(props.transform === undefined ? {} : { transform: props.transform })}
      {...(props.path === undefined ? {} : { path: props.path })}
    />
  );
}
