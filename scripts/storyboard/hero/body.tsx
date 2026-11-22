import { getColor } from './kit.ts';
import type { Palette } from './palette.ts';
import { roundTenth } from './round-tenth.ts';

interface BodyProps {
  readonly size: number;
  readonly palette: Palette;

  // Absent: a cube. A small height makes a flat box.
  readonly height?: number;
}

// A cube, or with a small height a flat box, in local coordinates and standing on (0, 0).
export function Body(props: BodyProps) {
  const size = props.size;
  const height = props.height ?? size * 1.15;
  const half = size / 2;
  const round = roundTenth;

  return (
    <>
      <path
        d={`M${round(-size)} ${round(-height)}L0 ${round(-height + half)}V${round(half)}L${round(-size)} 0Z`}
        fill={getColor(props.palette.left)}
      />
      <path
        d={`M0 ${round(-height + half)}L${round(size)} ${round(-height)}V0L0 ${round(half)}Z`}
        fill={getColor(props.palette.right)}
      />
      <path
        d={`M0 ${round(-height - half)}L${round(size)} ${round(-height)}L0 ${round(-height + half)}L${round(-size)} ${round(-height)}Z`}
        fill={getColor(props.palette.top)}
      />
      <path
        d={`M${round(-size)} ${round(-height)}L0 ${round(-height + half)}L${round(size)} ${round(-height)}`}
        fill="none"
        stroke={getColor('white')}
        stroke-opacity={0.55}
        stroke-width={0.9}
      />
    </>
  );
}
