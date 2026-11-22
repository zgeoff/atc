import { Agent } from './agent.tsx';
import type { FaceState } from './face.tsx';
import { GlowPad } from './glow-pad.tsx';
import { BACKGROUND_SIZE } from './layout.ts';
import type { AgentKind } from './palette.ts';

interface BackgroundCubeProps {
  readonly x: number;
  readonly y: number;
  readonly kind: AgentKind;
  readonly state: FaceState;
  readonly seed: number;
  readonly flicker?: readonly [periodS: number, phaseS: number];
}

// An agent in the background: a quiet glow and no part in the story.
export function BackgroundCube(props: BackgroundCubeProps) {
  const isIdle = props.state === 'idle';

  return (
    <>
      {isIdle ? null : (
        <GlowPad
          x={props.x}
          y={props.y}
          size={BACKGROUND_SIZE}
          tone={`${props.kind}Left`}
          opacity={0.16}
        />
      )}
      <Agent
        x={props.x}
        y={props.y}
        size={BACKGROUND_SIZE}
        kind={props.kind}
        faces={[{ state: props.state, windows: [[undefined, undefined]] }]}
        isIdle={isIdle}
        isDim
        seed={props.seed}
        {...(isIdle || props.flicker === undefined ? {} : { flicker: props.flicker })}
      />
    </>
  );
}
