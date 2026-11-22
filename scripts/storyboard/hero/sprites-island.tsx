import { Agent } from './agent.tsx';
import { BackgroundCube } from './background-cube.tsx';
import { CUT_S, FADE_S, UNIT_S } from './constants.ts';
import { Flash } from './flash.tsx';
import { GlowPad } from './glow-pad.tsx';
import { Island } from './island.tsx';
import { getColor, getURL } from './kit.ts';
import { BUILDER_UI, NAMED_SIZE, ORCHESTRATOR, SPRITES } from './layout.ts';
import { Ripple } from './ripple.tsx';
import { Show } from './show.tsx';
import { Squash, buildCrouch, buildHopCrouch, buildPop } from './squash.tsx';
import { times } from './times.ts';
import { Track } from './track.tsx';
import type { TrackKey } from './track.tsx';
import { buildWhen } from './when.ts';
import { Windows } from './windows.tsx';

// builder-ui flies off the orchestrator's lid in one arc onto the sprite, and lives there.
export function SpritesIsland() {
  const x = BUILDER_UI.x;
  const y = BUILDER_UI.y;

  return (
    <Island
      x={SPRITES.x}
      y={SPRITES.y}
      width={SPRITES.width}
      depth={22}
      title="SPRITES"
      subtitle="fly.io"
      shard={30}
      bob={[6, 3]}
    >
      <BackgroundCube x={SPRITES.x - 50} y={SPRITES.y + 10} kind="grok" state="idle" seed={2.2} />
      <Ripple x={x} y={y} when={times.spawnLanded} tone="violet" radius={60} />
      <Ripple x={x} y={y} when={buildWhen('spawnLanded', 0.5)} tone="violet" radius={50} />
      {renderContrail()}
      {renderCraft()}
      <Flash x={x} y={y - 16} when={times.spawnLanded} tone="violet" radius={36} />
      <Flash x={x} y={y - 18} when={times.need} tone="amber" radius={40} />
      <Ripple x={x} y={y} when={times.hop} tone="amber" radius={64} />
      <Ripple
        x={x}
        y={y}
        when={buildWhen(times.hop.reference, times.hop.offsetS + 0.05 * UNIT_S)}
        tone="amber"
        radius={64}
      />
      <Flash x={x} y={y - 18} when={times.cleared} tone="green" radius={40} />
      <Ripple x={x} y={y} when={times.cleared} tone="green" radius={64} />
    </Island>
  );
}

const FLIGHT_S = 0.75;
const TRAIL = 0.2;
const TRAIL_OUT_S = 0.5;

// where the craft leaves the orchestrator's lid, and the curve's two handles, then where it lands
const START = { x: ORCHESTRATOR.x, y: ORCHESTRATOR.y - NAMED_SIZE * 1.15 - 1 };
const HANDLE_OUT = { x: START.x + 95, y: START.y - 60 };
const HANDLE_IN = { x: BUILDER_UI.x + 10, y: BUILDER_UI.y - 150 };

// A short contrail that follows the craft: a dash whose head is on the craft.
function renderContrail() {
  const path = `M${START.x} ${START.y} C ${HANDLE_OUT.x} ${HANDLE_OUT.y} ${HANDLE_IN.x} ${HANDLE_IN.y} ${BUILDER_UI.x} ${BUILDER_UI.y}`;

  const follow: TrackKey[] = [
    [0, TRAIL],
    ...buildFlightKeys()
      .slice(1)
      .map(([offsetS, ease]): TrackKey => [offsetS, Number((TRAIL - Number(ease)).toFixed(4))]),
  ];

  const lifted = (peak: number, landed: number) => (
    <>
      <Track
        when={times.spawnLift}
        attribute="opacity"
        keys={[
          [0, 0],
          [CUT_S, peak],
          [FLIGHT_S, landed],
        ]}
      />
      <Track
        when={buildWhen('spawnLanded')}
        attribute="opacity"
        keys={[
          [0, landed],
          [TRAIL_OUT_S, 0],
        ]}
      />
    </>
  );

  const fadeOut = (
    <Track
      when={buildWhen('spawnLanded', TRAIL_OUT_S)}
      attribute="stroke-dashoffset"
      keys={[
        [0, TRAIL - 1],
        [CUT_S, TRAIL],
      ]}
    />
  );

  return (
    <g transform={`translate(0 ${-NAMED_SIZE * 0.55})`}>
      <path
        d={path}
        fill="none"
        stroke={getColor('violet')}
        stroke-width={4}
        stroke-linecap="round"
        pathLength={1}
        stroke-dasharray={`${TRAIL} 2`}
        stroke-dashoffset={TRAIL}
        opacity={0}
        filter={getURL('soft2')}
      >
        <Track when={times.spawnLift} attribute="stroke-dashoffset" keys={follow} />
        {fadeOut}
        {lifted(0.55, 0.45)}
      </path>
      <path
        d={path}
        fill="none"
        stroke={getColor('trailCore')}
        stroke-width={1.1}
        stroke-linecap="round"
        pathLength={1}
        stroke-dasharray={`${TRAIL} 2`}
        stroke-dashoffset={TRAIL}
        opacity={0}
      >
        <Track when={times.spawnLift} attribute="stroke-dashoffset" keys={follow} />
        {fadeOut}
        {lifted(0.75, 0.5)}
      </path>
    </g>
  );
}

const STEPS = 48;

function buildFlightKeys(): TrackKey[] {
  return Array.from({ length: STEPS + 1 }, (_, index): TrackKey => {
    const share = index / STEPS;

    return [FLIGHT_S * share, Number(getFlightEase(share).toFixed(4))];
  });
}

// A gentle lift-off, a quick cruise, a long settle.
function getFlightEase(share: number): number {
  const smooth = share * share * (3 - 2 * share);
  const decelerated = 1 - (1 - share) ** 2.2;

  return 0.45 * smooth + 0.55 * decelerated;
}

function renderCraft() {
  const x = BUILDER_UI.x;
  const y = BUILDER_UI.y;
  const home = { x: START.x - x, y: START.y - y };
  const path = `M${home.x} ${home.y} C ${HANDLE_OUT.x - x} ${HANDLE_OUT.y - y} ${HANDLE_IN.x - x} ${HANDLE_IN.y - y} 0 0`;

  const grow: TrackKey[] = [
    [-FADE_S, '.1 .1'],
    [-0.004 * UNIT_S, '.42 .42'],
    [0.004 * UNIT_S, '.36 .44'],
    [2 * FADE_S, '1 1'],
  ];

  return (
    <g opacity={0}>
      <Show from={times.spawnGrow} fadeInS={FADE_S} />
      <g>
        <Track when={times.spawnLift} attribute="motion" path={path} keys={buildFlightKeys()} />
        <g opacity={0}>
          <Windows windows={[[times.spawnGrow, times.spawnLanded]]} />
          <Squash x={x} y={y} spans={[{ when: times.spawnLift, keys: grow }]}>
            <circle
              cx={x}
              cy={y - NAMED_SIZE * 0.7}
              r={24}
              fill={getColor('violet')}
              opacity={0.35}
              filter={getURL('soft')}
            />
          </Squash>
        </g>
        <g opacity={0}>
          <Show from={times.spawnLanded} to={times.uiLine} />
          <GlowPad x={x} y={y} size={NAMED_SIZE} tone="violet" opacity={0.5} />
        </g>
        <g opacity={0}>
          <Windows
            windows={[
              [times.uiLine, times.need],
              [times.cleared, undefined],
            ]}
          />
          <GlowPad x={x} y={y} size={NAMED_SIZE} tone="claudeLeft" opacity={0.4} isBreathing />
        </g>
        <g opacity={0}>
          <Show from={times.need} to={times.cleared} />
          <GlowPad x={x} y={y} size={NAMED_SIZE} tone="amber" opacity={0.6} />
        </g>
        <g>
          <Track
            when={times.need}
            attribute="transform"
            transform="translate"
            keys={[
              [0, '0 0'],
              [0.012 * UNIT_S, '0 -16'],
              [0.39, '0 0'],
            ]}
          />
          <Squash x={x} y={y} spans={[{ when: times.spawnLift, keys: grow }]}>
            <Squash
              x={x}
              y={y}
              spans={[
                buildPop(times.spawnLanded, 1.15),
                buildCrouch(times.askLift),
                buildPop(times.answerLanded, 1, true),
                buildHopCrouch(times.need),
                buildPop(times.hop, 1.25),
                buildPop(times.cleared, 0.9),
              ]}
            >
              <Agent
                x={x}
                y={y}
                size={NAMED_SIZE}
                kind="claude"
                seed={0.6}
                need={{ from: times.need, to: times.cleared }}
                flight={[[times.spawnLift, times.spawnLanded]]}
                faces={[
                  {
                    state: 'boot',
                    windows: [[times.spawnLanded, times.uiLine]],
                    bootFrom: times.spawnLanded,
                  },
                  { state: 'code', windows: [[times.uiLine, times.askLift]] },
                  { state: 'think', windows: [[times.askLift, times.answerLanded]] },
                  { state: 'code', windows: [[times.answerLanded, times.need]] },
                  { state: 'need', windows: [[times.need, times.cleared]] },
                  { state: 'code', windows: [[times.cleared, undefined]] },
                ]}
              />
            </Squash>
          </Squash>
        </g>
      </g>
    </g>
  );
}
