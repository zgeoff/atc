import { Ambient, getColor, getURL } from './kit.ts';
import { GATEWAY, IMPZ, LAPTOP, SPRITES } from './layout.ts';
import { starData } from './star-data.ts';

const LINKS = [
  {
    from: [LAPTOP.x + LAPTOP.width - 4, LAPTOP.y],
    to: [GATEWAY.x - GATEWAY.width + 6, GATEWAY.y + 4],
    sag: 16,
  },
  {
    from: [IMPZ.x - IMPZ.width + 4, IMPZ.y],
    to: [GATEWAY.x + GATEWAY.width - 6, GATEWAY.y + 4],
    sag: 16,
  },
  {
    from: [SPRITES.x + 20, SPRITES.y - SPRITES.width / 2 + 12],
    to: [GATEWAY.x - 30, GATEWAY.y + GATEWAY.width / 2 + 8],
    sag: -10,
  },
] as const;

// The night sky: its glow, the stars, and the faint links from each island to the gateway.
export function Backdrop() {
  return (
    <>
      <rect width={1000} height={620} fill={getURL('sky')} />
      <ellipse cx={300} cy={420} rx={330} ry={190} fill={getURL('nebula')} />
      <ellipse cx={720} cy={220} rx={300} ry={190} fill={getURL('nebula')} />
      {starData.map((star) => (
        <circle cx={star.x} cy={star.y} r={star.radius} fill={getColor('star')}>
          <Ambient
            attribute="opacity"
            periodS={star.periodS}
            values={[0.15, 0.8, 0.15]}
            phaseS={star.phaseS}
          />
        </circle>
      ))}
      {LINKS.map((link) => {
        const [fromX, fromY] = link.from;
        const [toX, toY] = link.to;
        const middleX = Math.round((fromX + toX) / 2);
        const middleY = Math.round((fromY + toY) / 2 + link.sag);

        return (
          <path
            d={`M${fromX} ${fromY} Q ${middleX} ${middleY} ${toX} ${toY}`}
            fill="none"
            stroke={getColor('link')}
            stroke-opacity={0.2}
            stroke-width={1.2}
            stroke-dasharray="2 6"
          >
            <Ambient attribute="stroke-dashoffset" periodS={1.5} values={[0, -16]} />
          </path>
        );
      })}
    </>
  );
}
