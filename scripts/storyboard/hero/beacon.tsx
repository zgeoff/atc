import { CUT_S, UNIT_S } from './constants.ts';
import { Flash } from './flash.tsx';
import { Ambient, getColor, getURL } from './kit.ts';
import { BEACON } from './layout.ts';
import { Ripple } from './ripple.tsx';
import { Show } from './show.tsx';
import { times } from './times.ts';
import { Track } from './track.tsx';
import { buildWhen } from './when.ts';

const DIAMOND = 'M0 -13L8.5 0L0 13L-8.5 0Z';

// The tower's beacon: it pulses as each event passes on its way to the inbox.
export function Beacon() {
  const x = BEACON.x;
  const y = BEACON.y;

  return (
    <>
      <ellipse
        cx={x}
        cy={y + 18}
        rx={18}
        ry={7}
        fill={getColor('teal')}
        opacity={0.2}
        filter={getURL('soft')}
      />
      <g transform={`translate(${x} ${y})`}>
        <g>
          <Ambient
            attribute="transform"
            transform="translate"
            periodS={2}
            values={['0 0', '0 -3', '0 0']}
            keyFractions={[0, 0.5, 1]}
            ease="smooth"
          />
          <g>
            <Track
              when={times.eventPassed}
              attribute="transform"
              transform="scale"
              keys={[
                [0, '1'],
                [0.008 * UNIT_S, '1.18'],
                [0.02 * UNIT_S, '1'],
              ]}
            />
            <Track
              when={times.needPassed}
              attribute="transform"
              transform="scale"
              keys={[
                [0, '1'],
                [0.01 * UNIT_S, '1.4'],
                [0.025 * UNIT_S, '.88'],
                [0.038 * UNIT_S, '1'],
              ]}
            />
            <Track
              when={times.clearedPassed}
              attribute="transform"
              transform="scale"
              keys={[
                [0, '1'],
                [0.01 * UNIT_S, '1.3'],
                [0.025 * UNIT_S, '.92'],
                [0.038 * UNIT_S, '1'],
              ]}
            />
            <ellipse
              rx={17}
              ry={6}
              fill="none"
              stroke={getColor('teal')}
              stroke-opacity={0.55}
              stroke-width={1.4}
            />
            <path d="M0 -13L8.5 0L0 13L-8.5 0Z" fill={getColor('beaconTop')} />
            <path d="M0 -13L8.5 0L0 2.4Z" fill={getColor('beaconGlint')} />
            <path d="M0 2.4L8.5 0L0 13Z" fill={getColor('beaconRight')} />
            <path d="M0 2.4L-8.5 0L0 13Z" fill={getColor('beaconLeft')} />
            <path d={DIAMOND} fill={getColor('white')} opacity={0}>
              <Ambient
                attribute="opacity"
                periodS={2}
                values={[0, 0, 0.75, 0, 0]}
                keyFractions={[0, 0.78, 0.82, 0.9, 1]}
              />
            </path>
            <path d={DIAMOND} fill={getColor('violet')} opacity={0}>
              <Track
                when={times.eventPassed}
                attribute="opacity"
                keys={[
                  [-CUT_S, 0],
                  [0, 0.9],
                  [0.04 * UNIT_S, 0],
                ]}
              />
            </path>
            <path d={DIAMOND} fill={getColor('amber')} opacity={0}>
              <Track
                when={times.needPassed}
                attribute="opacity"
                keys={[
                  [-CUT_S, 0],
                  [0, 1],
                  [0.06 * UNIT_S, 0.7],
                ]}
              />
              <Track
                when={times.clearedPassed}
                attribute="opacity"
                keys={[
                  [0, 0.7],
                  [CUT_S, 0],
                ]}
              />
            </path>
            <path d={DIAMOND} fill={getColor('green')} opacity={0}>
              <Track
                when={times.clearedPassed}
                attribute="opacity"
                keys={[
                  [-CUT_S, 0],
                  [0, 1],
                  [CUT_S, 0.8],
                ]}
              />
              <Track
                when={times.cleared}
                attribute="opacity"
                keys={[
                  [0, 0.8],
                  [CUT_S, 0],
                ]}
              />
            </path>
            <ellipse
              rx={17}
              ry={6}
              fill="none"
              stroke={getColor('amber')}
              stroke-width={1.6}
              opacity={0}
            >
              <Show from={times.needPassed} to={times.clearedPassed} />
            </ellipse>
          </g>
        </g>
      </g>
      <Ripple x={x} y={y} when={times.needPassed} tone="amber" radius={60} flatness={0.4} />
      <Ripple
        x={x}
        y={y}
        when={buildWhen(times.needPassed.reference, 0.04 * UNIT_S)}
        tone="amber"
        radius={60}
        flatness={0.4}
      />
      <Ripple x={x} y={y} when={times.clearedPassed} tone="green" radius={60} flatness={0.4} />
      <Flash x={x} y={y} when={times.eventPassed} tone="violet" radius={22} />
      <Flash x={x} y={y} when={times.needPassed} tone="amber" radius={40} />
      <Flash x={x} y={y} when={times.clearedPassed} tone="green" radius={36} />
      <Flash x={x} y={y} when={times.resultPassed} tone="green" radius={22} />
    </>
  );
}
