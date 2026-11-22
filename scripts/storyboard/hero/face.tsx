import { Ambient, getColor } from './kit.ts';
import type { TokenName } from './kit.ts';
import { roundTenth } from './round-tenth.ts';
import { Track } from './track.tsx';
import type { When } from './when.ts';
import { Windows, isShownAtStart } from './windows.tsx';
import type { Window } from './windows.tsx';

export type FaceState = 'code' | 'think' | 'need' | 'idle' | 'boot';

interface FaceProps {
  readonly size: number;
  readonly state: FaceState;

  // The token of the cube's lit colour.
  readonly lit: TokenName;
  readonly windows: readonly Window[];
  readonly seed: number;

  // A boot bar fills over the window, which starts here.
  readonly bootFrom?: When;
}

// One state of the screen on a cube's left face, shown during its windows.
export function Face(props: FaceProps) {
  const size = props.size;
  const height = size * 1.15;
  const round = roundTenth;
  const left = size * 0.14;
  const top = height * 0.17;
  const width = size * 0.72;
  const tall = height * 0.62;

  return (
    <g opacity={isShownAtStart(props.windows) ? 1 : 0}>
      <Windows windows={props.windows} />
      <g transform={`translate(${round(-size)} ${round(-height)}) skewY(26.565)`}>
        <rect
          x={round(left)}
          y={round(top)}
          width={round(width)}
          height={round(tall)}
          rx={1.5}
          fill={getColor('screen')}
          opacity={0.92}
        />
        {renderState(props, { left, top, width, tall })}
      </g>
    </g>
  );
}

interface Screen {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly tall: number;
}

const BAR_SHARES = [0.42, 0.62, 0.3];

const THINK_DOTS = [
  [0, 1],
  [2.1, 0.6],
  [4.2, 0.3],
] as const;

function renderState(props: FaceProps, screen: Screen) {
  const size = props.size;
  const round = roundTenth;

  if (props.state === 'code') {
    return BAR_SHARES.map((share, index) => {
      const barWidth = screen.width * share;

      return (
        <rect
          x={round(screen.left + screen.width * 0.14)}
          y={round(screen.top + screen.tall * (0.2 + 0.27 * index))}
          width={round(barWidth)}
          height={round(Math.max(1.3, size * 0.08))}
          fill={getColor(props.lit)}
          opacity={Number((0.95 - index * 0.15).toFixed(2))}
        >
          <Ambient
            attribute="width"
            periodS={1.6}
            values={[0, round(barWidth), round(barWidth)]}
            keyFractions={[0, 0.55, 1]}
            phaseS={Number(((props.seed + index * 0.45) % 1.6).toFixed(2))}
          />
        </rect>
      );
    });
  }

  if (props.state === 'think') {
    const radius = size * 0.17;

    return (
      <g
        transform={`translate(${round(screen.left + screen.width / 2)} ${round(screen.top + screen.tall / 2)})`}
      >
        <g>
          {THINK_DOTS.map(([angle, opacity]) => (
            <circle
              cx={round(radius * Math.cos(angle))}
              cy={round(radius * Math.sin(angle))}
              r={round(size * 0.07 + 0.3)}
              fill={getColor(props.lit)}
              opacity={opacity}
            />
          ))}
          <Ambient attribute="transform" transform="rotate" periodS={1} values={[0, 360]} />
        </g>
      </g>
    );
  }

  if (props.state === 'need') {
    return (
      <rect
        x={round(screen.left)}
        y={round(screen.top)}
        width={round(screen.width)}
        height={round(screen.tall)}
        rx={1.5}
        fill={getColor('screenAlert')}
      >
        <Ambient attribute="opacity" periodS={0.8} values={[0.95, 0.1, 0.95]} />
      </rect>
    );
  }

  if (props.state === 'idle') {
    return (
      <rect
        x={round(screen.left + screen.width * 0.2)}
        y={round(screen.top + screen.tall * 0.5)}
        width={round(screen.width * 0.35)}
        height={1.3}
        fill={getColor('faint')}
      >
        <Ambient
          attribute="opacity"
          periodS={4}
          values={[0.3, 1, 0.3]}
          phaseS={Number(props.seed.toFixed(2))}
        />
      </rect>
    );
  }

  return renderBoot(props, screen);
}

const BOOT_LAG_S = 0.15;
const BOOT_HOLD_S = 0.38;

function renderBoot(props: FaceProps, screen: Screen) {
  const round = roundTenth;
  const barWidth = screen.width * 0.7;
  const barLeft = screen.left + screen.width * 0.15;
  const barTop = screen.top + screen.tall * 0.42;
  const barHeight = Math.max(1.6, props.size * 0.13);

  return (
    <>
      <rect
        x={round(barLeft)}
        y={round(barTop)}
        width={round(barWidth)}
        height={round(barHeight)}
        rx={1}
        fill="none"
        stroke={getColor(props.lit)}
        stroke-opacity={0.5}
        stroke-width={0.8}
      />
      <rect
        x={round(barLeft)}
        y={round(barTop)}
        width={0}
        height={round(barHeight)}
        rx={1}
        fill={getColor(props.lit)}
      >
        {props.bootFrom === undefined ? null : (
          <Track
            when={props.bootFrom}
            attribute="width"
            keys={[
              [BOOT_LAG_S, 0],
              [BOOT_HOLD_S, round(barWidth)],
            ]}
          />
        )}
      </rect>
    </>
  );
}
