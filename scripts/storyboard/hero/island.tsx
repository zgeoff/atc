import type { StoryNode } from '@zgeoff/storyboard';
import { formatPoints } from './format-points.ts';
import { Ambient, getColor, getURL } from './kit.ts';

interface IslandProps {
  readonly x: number;
  readonly y: number;

  // half the width of the top face
  readonly width: number;
  readonly depth: number;
  readonly title: string;
  readonly subtitle: string;

  // how far the crystal underside reaches below the slab
  readonly shard: number;
  readonly bob: readonly [periodS: number, amplitude: number];
  readonly children: StoryNode;
}

// A floating isometric slab with a crystal underside, its name on the front faces.
export function Island(props: IslandProps) {
  const x = props.x;
  const y = props.y;
  const width = props.width;
  const depth = props.depth;
  const shard = props.shard;
  const half = width / 2;
  const apex = y + half + depth + shard;
  const angle = (Math.atan2(half, width) * 180) / Math.PI;
  const [periodS, amplitude] = props.bob;
  const quarters = [1, 2, 3].map((index) => index / 4);

  return (
    <g>
      <Ambient
        attribute="transform"
        transform="translate"
        periodS={periodS}
        values={['0 0', `0 ${-amplitude}`, '0 0']}
        keyFractions={[0, 0.5, 1]}
        ease="smooth"
      />
      <ellipse
        cx={x}
        cy={(apex - shard * 0.25).toFixed(1)}
        rx={(width * 0.9).toFixed(1)}
        ry={(shard * 0.5).toFixed(1)}
        fill={getURL('haze')}
        opacity={0.55}
      />
      <polygon
        points={formatPoints([
          [x - width, y + depth],
          [x, y + half + depth],
          [x, apex],
        ])}
        fill={getColor('shardLeft')}
      />
      <polygon
        points={formatPoints([
          [x, y + half + depth],
          [x + width, y + depth],
          [x, apex],
        ])}
        fill={getColor('shardRight')}
      />
      <polygon
        points={formatPoints([
          [x - width * 0.45, y + depth + half * 0.55],
          [x, y + half + depth],
          [x, apex],
        ])}
        fill={getColor('shardGlint')}
        opacity={0.7}
      />
      <polygon
        points={formatPoints([
          [x - width, y],
          [x, y + half],
          [x, y + half + depth],
          [x - width, y + depth],
        ])}
        fill={getColor('slateLeft')}
      />
      <polygon
        points={formatPoints([
          [x, y + half],
          [x + width, y],
          [x + width, y + depth],
          [x, y + half + depth],
        ])}
        fill={getColor('slateRight')}
      />
      <polygon
        points={formatPoints([
          [x, y - half],
          [x + width, y],
          [x, y + half],
          [x - width, y],
        ])}
        fill={getURL('slateTop')}
      />
      <g stroke={getColor('white')} stroke-opacity={0.06} stroke-width={1}>
        {quarters.map((share) => (
          <>
            <line
              x1={(x - width + width * share).toFixed(1)}
              y1={(y - half * share).toFixed(1)}
              x2={(x + width * share).toFixed(1)}
              y2={(y + half - half * share).toFixed(1)}
            />
            <line
              x1={(x + width - width * share).toFixed(1)}
              y1={(y - half * share).toFixed(1)}
              x2={(x - width * share).toFixed(1)}
              y2={(y + half - half * share).toFixed(1)}
            />
          </>
        ))}
      </g>
      <polyline
        points={formatPoints([
          [x - width, y],
          [x, y + half],
          [x + width, y],
        ])}
        fill="none"
        stroke={getColor('white')}
        stroke-opacity={0.28}
        stroke-width={1.2}
      />
      <polyline
        points={formatPoints([
          [x - width, y],
          [x, y - half],
          [x + width, y],
        ])}
        fill="none"
        stroke={getColor('white')}
        stroke-opacity={0.1}
        stroke-width={1}
      />
      <g
        transform={`translate(${(x - width).toFixed(1)} ${y.toFixed(1)}) skewY(${angle.toFixed(3)})`}
      >
        <text x={(width * 0.14).toFixed(1)} y={(depth * 0.5 + 4.6).toFixed(1)} class="face">
          {props.title}
        </text>
      </g>
      <g
        transform={`translate(${x.toFixed(1)} ${(y + half).toFixed(1)}) skewY(${(-angle).toFixed(3)})`}
      >
        <text x={(width * 0.12).toFixed(1)} y={(depth * 0.5 + 4).toFixed(1)} class="facesub">
          {props.subtitle}
        </text>
      </g>
      {props.children}
    </g>
  );
}
