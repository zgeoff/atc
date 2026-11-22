import { Body } from './body.tsx';
import { Face } from './face.tsx';
import type { FaceState } from './face.tsx';
import { Ambient, getColor, getURL } from './kit.ts';
import type { TokenName } from './kit.ts';
import { buildPalette } from './palette.ts';
import type { AgentKind, Palette } from './palette.ts';
import { roundTenth } from './round-tenth.ts';
import { Show } from './show.tsx';
import type { When } from './when.ts';
import { Windows } from './windows.tsx';
import type { Window } from './windows.tsx';

export interface AgentFace {
  readonly state: FaceState;
  readonly windows: readonly Window[];
  readonly bootFrom?: When;
}

interface AgentProps {
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly kind: AgentKind;
  readonly faces: readonly AgentFace[];
  readonly isIdle?: boolean;
  readonly isDim?: boolean;
  readonly seed?: number;

  // The window in which the cube is amber, because it needs the person.
  readonly need?: { readonly from: When; readonly to: When };

  // The period and phase of a flicker on the lid.
  readonly flicker?: readonly [periodS: number, phaseS: number];

  // The windows in which the cube is airborne.
  readonly flight?: readonly Window[];
}

const AMBER_PALETTE: Palette = { top: 'amberTop', left: 'amberLeft', right: 'amberRight' };

// A cube agent standing on (x, y), whose left face shows what it is doing.
export function Agent(props: AgentProps) {
  const size = props.size;
  const round = roundTenth;
  const height = size * 1.15;
  const palette = buildPalette(props.kind, pickShade(props));
  const markColor: TokenName = props.isIdle === true ? `${props.kind}MarkIdle` : palette.right;

  return (
    <g transform={`translate(${round(props.x)} ${round(props.y)})`}>
      <Body size={size} palette={palette} />
      {props.need === undefined ? null : (
        <g opacity={0}>
          <Show from={props.need.from} to={props.need.to} />
          <Body size={size} palette={AMBER_PALETTE} />
        </g>
      )}
      {props.faces.map((face) => (
        <Face
          size={size}
          state={face.state}
          lit={face.state === 'need' ? 'amberTop' : palette.top}
          windows={face.windows}
          seed={props.seed ?? 0}
          {...(face.bootFrom === undefined ? {} : { bootFrom: face.bootFrom })}
        />
      ))}
      <g transform={`translate(0 ${round(-height)}) scale(1 .5) rotate(45)`} opacity={0.85}>
        {renderMark(props.kind, size, markColor)}
      </g>
      {props.flicker === undefined ? null : (
        <path
          d={`M0 ${round(-height - size / 2)}L${round(size)} ${round(-height)}L0 ${round(-height + size / 2)}L${round(-size)} ${round(-height)}Z`}
          fill={getColor('white')}
          opacity={0}
        >
          <Ambient
            attribute="opacity"
            periodS={props.flicker[0]}
            values={[0, 0.45, 0, 0]}
            keyFractions={[0, 0.15, 0.4, 1]}
            phaseS={props.flicker[1]}
          />
        </path>
      )}
      {props.flight === undefined ? null : (
        <g opacity={0}>
          <Windows windows={props.flight} />
          <circle
            cx={0}
            cy={round(-height - size * 0.5 - 3)}
            r={2.6}
            fill={getColor('white')}
            filter={getURL('glow')}
            opacity={0}
          >
            <Ambient
              attribute="opacity"
              periodS={1.2}
              values={[0, 1, 0, 1, 0, 0]}
              keyFractions={[0, 0.04, 0.09, 0.13, 0.18, 1]}
            />
          </circle>
        </g>
      )}
    </g>
  );
}

function pickShade(props: AgentProps): '' | 'Dim' | 'Idle' {
  if (props.isIdle === true) {
    return 'Idle';
  }

  return props.isDim === true ? 'Dim' : '';
}

// The agent kind's mark, painted on the lid: claude a dot, codex a square ring, grok a triangle.
function renderMark(kind: AgentKind, size: number, color: TokenName) {
  const round = roundTenth;
  const reach = size * 0.44;

  if (kind === 'claude') {
    return <circle r={round(reach * 0.62)} fill={getColor(color)} />;
  }

  if (kind === 'codex') {
    const radius = reach * 0.58;

    return (
      <rect
        x={round(-radius)}
        y={round(-radius)}
        width={round(2 * radius)}
        height={round(2 * radius)}
        fill="none"
        stroke={getColor(color)}
        stroke-width={round(size * 0.12)}
      />
    );
  }

  const radius = reach * 0.8;

  return (
    <path
      d={`M0 ${round(-radius)}L${round(radius * 0.87)} ${round(radius * 0.5)}L${round(-radius * 0.87)} ${round(radius * 0.5)}Z`}
      fill={getColor(color)}
    />
  );
}
