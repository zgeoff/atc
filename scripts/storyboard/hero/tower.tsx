import { Body } from './body.tsx';
import { formatPoints } from './format-points.ts';
import { Ambient, getColor } from './kit.ts';
import { BEACON, GATEWAY, TOWER_FOOT } from './layout.ts';
import type { Palette } from './palette.ts';

const STONE: Palette = { top: 'stoneTop', left: 'stoneLeft', right: 'stoneRight' };
const LIGHT: Palette = { top: 'towerLightTop', left: 'towerLightLeft', right: 'towerLightRight' };
const ROOF: Palette = { top: 'roofTop', left: 'roofLeft', right: 'roofRight' };

// The gateway's control tower: a base, a shaft, a glass cab and a roof, with a mast to the beacon.
export function Tower() {
  const x = GATEWAY.x;
  const foot = TOWER_FOOT;

  return (
    <>
      <ellipse cx={x} cy={foot + 2} rx={20} ry={8} fill={getColor('ground')} opacity={0.35} />
      <g transform={`translate(${x} ${foot})`}>
        <Body size={14} palette={STONE} height={5} />
      </g>
      <g transform={`translate(${x} ${foot - 5})`}>
        <Body size={5.5} palette={LIGHT} height={48} />
      </g>
      <g transform={`translate(${x} ${foot - 53})`}>
        <Body size={10} palette={STONE} height={3} />
      </g>
      <g transform={`translate(${x} ${foot - 56})`}>{renderCab(13.5, 12)}</g>
      <g transform={`translate(${x} ${foot - 68})`}>
        <Body size={15.5} palette={ROOF} height={2.5} />
      </g>
      <g transform={`translate(${x} ${foot - 70.5})`}>
        <Body size={4} palette={LIGHT} height={3} />
      </g>
      <line
        x1={x}
        y1={foot - 75}
        x2={x}
        y2={BEACON.y + 9}
        stroke={getColor('mast')}
        stroke-width={1.3}
      />
    </>
  );
}

const GLASS: Palette = { top: 'glassTop', left: 'glassLeft', right: 'glassRight' };

// Dark glass with lit teal panes and mullions on both visible faces.
function renderCab(size: number, height: number) {
  const left = (x: number, share: number): [number, number] => [
    x,
    -height + (x + size) / 2 + height * share,
  ];

  const right = (x: number, share: number): [number, number] => [
    x,
    -height + size / 2 - x / 2 + height * share,
  ];

  const leftMullions = [-size * 0.75, -size * 0.5, -size * 0.25];
  const rightMullions = [size * 0.25, size * 0.5, size * 0.75];

  return (
    <>
      <Body size={size} palette={GLASS} height={height} />
      <polygon
        points={formatPoints([
          left(-size + 1.2, 0.2),
          left(-1.2, 0.2),
          left(-1.2, 0.62),
          left(-size + 1.2, 0.62),
        ])}
        fill={getColor('claudeTop')}
        opacity={0.55}
      />
      <polygon
        points={formatPoints([
          right(1.2, 0.2),
          right(size - 1.2, 0.2),
          right(size - 1.2, 0.62),
          right(1.2, 0.62),
        ])}
        fill={getColor('teal')}
        opacity={0.38}
      />
      <polygon
        points={formatPoints([
          left(-size + 1.2, 0.2),
          left(-size * 0.55, 0.2),
          left(-size * 0.55, 0.62),
          left(-size + 1.2, 0.62),
        ])}
        fill={getColor('white')}
        opacity={0.2}
      >
        <Ambient attribute="opacity" periodS={2.4} values={[0.05, 0.35, 0.05]} />
      </polygon>
      <g stroke={getColor('glassRight')} stroke-width={0.9}>
        {leftMullions.map((x) => (
          <line
            x1={x.toFixed(1)}
            y1={left(x, 0.08)[1].toFixed(1)}
            x2={x.toFixed(1)}
            y2={left(x, 0.92)[1].toFixed(1)}
          />
        ))}
        {rightMullions.map((x) => (
          <line
            x1={x.toFixed(1)}
            y1={right(x, 0.08)[1].toFixed(1)}
            x2={x.toFixed(1)}
            y2={right(x, 0.92)[1].toFixed(1)}
          />
        ))}
      </g>
    </>
  );
}
