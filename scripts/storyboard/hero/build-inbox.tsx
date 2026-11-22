import type { StoryNode } from '@zgeoff/storyboard';
import { CUT_S, FADE_S, UNIT_S } from './constants.ts';
import { Flash } from './flash.tsx';
import { Ambient, Def, defineHost, getColor, getID, getURL } from './kit.ts';
import type { TokenName } from './kit.ts';
import { INBOX, INBOX_FIRST_ROW_Y } from './layout.ts';
import { Show } from './show.tsx';
import { times } from './times.ts';
import { Track } from './track.tsx';
import type { TrackKey } from './track.tsx';
import { buildWhen } from './when.ts';

const PX = INBOX.x;
const PY = INBOX.y;
const PW = INBOX.width;
const PH = INBOX.height;
const ROW_H = INBOX.rowHeight;
const ROW_Y = INBOX_FIRST_ROW_Y;
const EVENT_X = PX + PW - 12;
const BAR_X = PX + 16;
const SETTLE_S = 0.7 * FADE_S;

// The inbox that floats above the tower: one row for each agent, and the gate that waits for a
// person. It is a host, so that a change can make it the acting part.
export const buildInbox = defineHost<undefined, never>({
  name: 'Inbox',
  render: () => <Panel />,
});

function Panel() {
  return (
    <>
      <Def>
        <clipPath id={getID('feedClip')}>
          <rect x={PX} y={PY + 31} width={PW} height={ROW_Y + 2 * ROW_H + 13 - PY - 31} />
        </clipPath>
      </Def>
      <g>
        <Ambient
          attribute="transform"
          transform="translate"
          periodS={5}
          values={['0 0', '0 -2', '0 0']}
          keyFractions={[0, 0.5, 1]}
          ease="smooth"
        />
        <g>
          <Track
            when={times.eventLanded}
            attribute="transform"
            transform="translate"
            keys={[
              [0, '0 0'],
              [0.006 * UNIT_S, '0 2'],
              [0.016 * UNIT_S, '0 0'],
            ]}
          />
          <Track
            when={times.needLanded}
            attribute="transform"
            transform="translate"
            keys={[
              [0, '0 0'],
              [0.006 * UNIT_S, '0 6'],
              [0.016 * UNIT_S, '0 -3'],
              [0.026 * UNIT_S, '0 0'],
            ]}
          />
          <Track
            when={times.clear}
            attribute="transform"
            transform="translate"
            keys={[
              [0, '0 0'],
              [0.006 * UNIT_S, '0 3'],
              [0.016 * UNIT_S, '0 0'],
            ]}
          />
          {renderFrame()}
          {renderHeader()}
          <g clip-path={getURL('feedClip')}>
            {renderRow({ name: 'builder-api', event: 'working', tone: 'dimText', slot: 0 })}
            {renderRow({ name: 'orchestrator', event: 'online', tone: 'dimText', slot: 1 })}
            {renderLandedRow()}
          </g>
          <Flash x={BAR_X} y={ROW_Y} when={times.eventLanded} tone="violet" radius={16} />
          <Flash x={BAR_X} y={ROW_Y} when={times.needLanded} tone="amber" radius={30} />
          <Flash x={PX + 146} y={ROW_Y} when={times.clear} tone="green" radius={40} />
          {renderVeil()}
        </g>
      </g>
    </>
  );
}

function renderFrame() {
  return (
    <>
      <rect
        x={PX}
        y={PY}
        width={PW}
        height={PH}
        rx={12}
        fill={getColor('panel')}
        fill-opacity={0.95}
        stroke={getColor('white')}
        stroke-opacity={0.1}
      />
      <rect
        x={PX}
        y={PY}
        width={PW}
        height={PH}
        rx={12}
        fill="none"
        stroke={getColor('amber')}
        stroke-width={1.8}
        opacity={0}
      >
        <Show from={times.needLanded} to={times.clear} />
        <Ambient attribute="stroke-opacity" periodS={1} values={[1, 0.45, 1]} />
      </rect>
      <rect
        x={PX}
        y={PY}
        width={PW}
        height={PH}
        rx={12}
        fill="none"
        stroke={getColor('green')}
        stroke-width={1.8}
        opacity={0}
      >
        <Track
          when={times.clear}
          attribute="opacity"
          keys={[
            [-CUT_S, 0],
            [0, 1],
          ]}
        />
        <Track
          when={times.cleared}
          attribute="opacity"
          keys={[
            [0, 0.5],
            [FADE_S, 0],
          ]}
        />
      </rect>
    </>
  );
}

function renderHeader() {
  const textY = PY + 20;

  return (
    <>
      <g
        fill="none"
        stroke={getColor('text')}
        stroke-width={1.4}
        stroke-linejoin="round"
        stroke-linecap="round"
      >
        <rect x={PX + 10} y={PY + 11.2} width={12} height={9.6} rx={2} />
        <path
          d={`M${PX + 10} ${PY + 16.5}H${PX + 13.6}L${PX + 14.5} ${PY + 18.1}H${PX + 17.5}L${PX + 18.4} ${PY + 16.5}H${PX + 22}`}
        />
      </g>
      <text x={PX + 28} y={textY} class="name">
        inbox
      </text>
      <text x={EVENT_X} y={textY} class="status" text-anchor="end" fill={getColor('dimText')}>
        <Track
          when={times.eventLanded}
          attribute="opacity"
          keys={[
            [0, 1],
            [CUT_S, 0],
          ]}
        />
        2 agents
      </text>
      <text
        x={EVENT_X}
        y={textY}
        class="status"
        text-anchor="end"
        fill={getColor('dimText')}
        opacity={0}
      >
        <Show from={times.eventLanded} to={times.needLanded} />
        <Show from={times.resultLanded} />
        <Track
          when={times.reset}
          attribute="opacity"
          keys={[
            [-2 * CUT_S, 1],
            [-CUT_S, 0],
          ]}
        />
        3 agents
      </text>
      <text
        x={EVENT_X}
        y={textY}
        class="status"
        text-anchor="end"
        fill={getColor('amber')}
        font-weight={700}
        opacity={0}
      >
        <Show from={times.needLanded} to={times.clear} />1 needs you
      </text>
      <text
        x={EVENT_X}
        y={textY}
        class="status"
        text-anchor="end"
        fill={getColor('green')}
        font-weight={700}
        opacity={0}
      >
        <Show from={times.clear} to={times.resultLanded} />
        cleared
      </text>
      <line
        x1={PX}
        y1={PY + 30}
        x2={PX + PW}
        y2={PY + 30}
        stroke={getColor('white')}
        stroke-opacity={0.08}
      />
    </>
  );
}

interface RowProps {
  readonly name: string;
  readonly event: string;
  readonly tone: TokenName;
  readonly slot: number;
}

// A row that is there from the first frame and moves down a slot when the new row lands.
function renderRow(props: RowProps) {
  const from = props.slot * ROW_H;

  const keys: TrackKey[] = [
    [0, `0 ${from}`],
    [SETTLE_S, `0 ${from + ROW_H + 3}`],
    [FADE_S, `0 ${from + ROW_H}`],
  ];

  return (
    <g>
      <Track when={times.eventLanded} attribute="transform" transform="translate" keys={keys} />
      <circle cx={BAR_X} cy={ROW_Y} r={3.5} fill={getColor(props.tone)} />
      <text x={EVENT_X} y={ROW_Y + 4} class="rowev" text-anchor="end" fill={getColor(props.tone)}>
        {props.event}
      </text>
      <text x={PX + 26} y={ROW_Y + 4} class="row">
        {props.name}
      </text>
    </g>
  );
}

// The row of builder-ui: it drops in as "spawned", turns into the gate, and is cleared.
function renderLandedRow() {
  return (
    <g opacity={0}>
      <Show from={times.eventLanded} fadeInS={FADE_S} />
      <Track
        when={times.eventLanded}
        attribute="transform"
        transform="translate"
        keys={[
          [0, `0 ${-ROW_H}`],
          [SETTLE_S, '0 2'],
          [FADE_S, '0 0'],
        ]}
      />
      <Band tone="violet">
        <Track
          when={times.eventLanded}
          attribute="opacity"
          keys={[
            [-CUT_S, 0],
            [0, 0.3],
            [FADE_S, 0.1],
          ]}
        />
        <Track
          when={times.needLanded}
          attribute="opacity"
          keys={[
            [-CUT_S, 0.1],
            [0, 0],
          ]}
        />
      </Band>
      <Band tone="amber">
        <Track
          when={times.needLanded}
          attribute="opacity"
          keys={[
            [-CUT_S, 0],
            [0, 0.5],
            [FADE_S, 0.2],
          ]}
        />
        <Track
          when={times.clear}
          attribute="opacity"
          keys={[
            [0, 0.2],
            [CUT_S, 0],
          ]}
        />
      </Band>
      <Band tone="green">
        <Track
          when={times.clear}
          attribute="opacity"
          keys={[
            [-CUT_S, 0],
            [0, 0.45],
            [FADE_S, 0.14],
          ]}
        />
      </Band>
      <circle cx={BAR_X} cy={ROW_Y} r={3.5} fill={getColor('violet')} />
      <circle cx={BAR_X} cy={ROW_Y} r={3.5} fill={getColor('amber')} opacity={0}>
        <Show from={times.needLanded} to={times.clear} />
      </circle>
      <circle cx={BAR_X} cy={ROW_Y} r={3.5} fill={getColor('green')} opacity={0}>
        <Show from={times.clear} />
      </circle>
      <text x={EVENT_X} y={ROW_Y + 4} class="rowev" text-anchor="end" fill={getColor('violet')}>
        <Track
          when={times.needLanded}
          attribute="opacity"
          keys={[
            [-2 * CUT_S, 1],
            [-CUT_S, 0],
          ]}
        />
        spawned
      </text>
      <text
        x={EVENT_X}
        y={ROW_Y + 4}
        class="rowev"
        text-anchor="end"
        fill={getColor('amber')}
        font-weight={700}
        opacity={0}
      >
        <Track
          when={times.needLanded}
          attribute="opacity"
          keys={[
            [0, 0],
            [CUT_S, 1],
          ]}
        />
        <Track
          when={buildWhen('clear', -0.004 * UNIT_S)}
          attribute="opacity"
          keys={[
            [0, 1],
            [0.004 * UNIT_S, 0],
          ]}
        />
        deploy to preview?
      </text>
      <text
        x={EVENT_X}
        y={ROW_Y + 4}
        class="rowev"
        text-anchor="end"
        fill={getColor('green')}
        opacity={0}
      >
        <Track
          when={times.resultLanded}
          attribute="opacity"
          keys={[
            [0.4 * FADE_S, 0],
            [FADE_S, 1],
          ]}
        />
        <Track
          when={times.reset}
          attribute="opacity"
          keys={[
            [-2 * CUT_S, 1],
            [-CUT_S, 0],
          ]}
        />
        preview live
      </text>
      <text x={PX + 26} y={ROW_Y + 4} class="row">
        builder-ui
      </text>
    </g>
  );
}

interface BandProps {
  readonly tone: TokenName;
  readonly children: StoryNode;
}

function Band(props: BandProps) {
  return (
    <rect
      x={PX + 6}
      y={ROW_Y - 10}
      width={PW - 12}
      height={21}
      rx={6}
      fill={getColor(props.tone)}
      opacity={0}
    >
      {props.children}
    </rect>
  );
}

// The panel is dim until an event or the gate makes it the acting part.
function renderVeil() {
  const lit: TrackKey[] = [
    [0, 0.6],
    [FADE_S, 0],
  ];

  const dim: TrackKey[] = [
    [0, 0],
    [FADE_S, 0.6],
  ];

  return (
    <rect x={PX} y={PY} width={PW} height={PH} rx={12} fill={getColor('veil')} opacity={0.6}>
      <Track when={times.eventLanded} attribute="opacity" keys={lit} />
      <Track when={times.askLine} attribute="opacity" keys={dim} />
      <Track when={times.needLanded} attribute="opacity" keys={lit} />
      <Track when={times.cleared} attribute="opacity" keys={dim} />
      <Track when={times.resultLanded} attribute="opacity" keys={lit} />
    </rect>
  );
}
