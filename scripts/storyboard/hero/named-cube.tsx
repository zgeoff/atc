import { Agent } from './agent.tsx';
import type { AgentFace } from './agent.tsx';
import { GlowPad } from './glow-pad.tsx';
import { NAMED_SIZE } from './layout.ts';
import type { AgentKind } from './palette.ts';
import { Squash } from './squash.tsx';
import type { SquashSpan } from './squash.tsx';

interface NamedCubeProps {
  readonly x: number;
  readonly y: number;
  readonly kind: AgentKind;
  readonly faces: readonly AgentFace[];
  readonly squashes: readonly SquashSpan[];
  readonly seed?: number;
}

// An agent of the story: a breathing glow in its kind's colour, and a squash at each arrival.
export function NamedCube(props: NamedCubeProps) {
  return (
    <>
      <GlowPad
        x={props.x}
        y={props.y}
        size={NAMED_SIZE}
        tone={`${props.kind}Left`}
        opacity={0.4}
        isBreathing
      />
      <Squash x={props.x} y={props.y} spans={props.squashes}>
        <Agent
          x={props.x}
          y={props.y}
          size={NAMED_SIZE}
          kind={props.kind}
          faces={props.faces}
          seed={props.seed ?? 0}
        />
      </Squash>
    </>
  );
}
