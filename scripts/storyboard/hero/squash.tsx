import type { StoryNode } from '@zgeoff/storyboard';
import { UNIT_S } from './constants.ts';
import { Track } from './track.tsx';
import type { TrackKey } from './track.tsx';
import type { When } from './when.ts';

export interface SquashSpan {
  readonly when: When;
  readonly keys: readonly TrackKey[];
}

interface SquashProps {
  readonly x: number;
  readonly y: number;
  readonly spans: readonly SquashSpan[];
  readonly children: StoryNode;
}

// Scales what it holds around the point (x, y), through each span in turn.
export function Squash(props: SquashProps) {
  return (
    <g transform={`translate(${props.x} ${props.y})`}>
      <g>
        {props.spans.map((span) => (
          <Track when={span.when} attribute="transform" transform="scale" keys={span.keys} />
        ))}
        <g transform={`translate(${-props.x} ${-props.y})`}>{props.children}</g>
      </g>
    </g>
  );
}

function scaleOf(horizontal: number, vertical: number): string {
  return `${Number(horizontal.toFixed(2))} ${Number(vertical.toFixed(2))}`;
}

// A punchy arrival: squash flat, overshoot tall, settle. A short one drops the last wobble.
export function buildPop(when: When, strength = 1, isShort = false): SquashSpan {
  const keys: TrackKey[] = [
    [0, '1 1'],
    [0.005 * UNIT_S, scaleOf(1 + 0.34 * strength, 1 - 0.36 * strength)],
    [0.015 * UNIT_S, scaleOf(1 - 0.14 * strength, 1 + 0.22 * strength)],
  ];

  if (isShort) {
    return { when, keys: [...keys, [0.025 * UNIT_S, '1 1']] };
  }

  return {
    when,
    keys: [
      ...keys,
      [0.025 * UNIT_S, scaleOf(1 + 0.06 * strength, 1 - 0.06 * strength)],
      [0.035 * UNIT_S, '1 1'],
    ],
  };
}

// Anticipation before a launch: gather down, spring up.
export function buildCrouch(when: When, leadUnits = 0.03): SquashSpan {
  return {
    when,
    keys: [
      [-leadUnits * UNIT_S, '1 1'],
      [-0.004 * UNIT_S, '1.16 .8'],
      [0.004 * UNIT_S, '.9 1.18'],
      [0.02 * UNIT_S, '1 1'],
    ],
  };
}

// A quick gather before a hop that leaves the ground at the instant.
export function buildHopCrouch(when: When): SquashSpan {
  return {
    when,
    keys: [
      [-0.012 * UNIT_S, '1 1'],
      [-0.003 * UNIT_S, '1.16 .8'],
      [0.005 * UNIT_S, '.88 1.2'],
      [0.016 * UNIT_S, '1 1'],
    ],
  };
}
