import { Ambient, getColor, getURL } from './kit.ts';
import type { TokenName } from './kit.ts';

interface GlowPadProps {
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly tone: TokenName;
  readonly opacity?: number;
  readonly isBreathing?: boolean;
}

// A soft pool of light under a cube, which can breathe.
export function GlowPad(props: GlowPadProps) {
  const opacity = props.opacity ?? 0.38;

  return (
    <ellipse
      cx={props.x}
      cy={(props.y + props.size * 0.15).toFixed(1)}
      rx={(props.size * 2.1).toFixed(1)}
      ry={(props.size * 1.05).toFixed(1)}
      fill={getColor(props.tone)}
      opacity={opacity}
      filter={getURL('soft')}
    >
      {props.isBreathing === true ? (
        <Ambient
          attribute="opacity"
          periodS={2.4}
          values={[
            Number((opacity * 0.7).toFixed(2)),
            Number((opacity * 1.25).toFixed(2)),
            Number((opacity * 0.7).toFixed(2)),
          ]}
        />
      ) : null}
    </ellipse>
  );
}
