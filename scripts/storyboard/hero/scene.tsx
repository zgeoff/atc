import { defineScene } from '@zgeoff/storyboard';
import { Backdrop } from './backdrop.tsx';
import { buildBowedPath } from './bowed-path.ts';
import { buildInbox } from './build-inbox.tsx';
import { Islands } from './islands.tsx';
import {
  Alert,
  Beat,
  Cursor,
  Flight,
  Line,
  Pulse,
  Stage,
  Stamp,
  Status,
  Type,
  buildTerminal,
  getColor,
} from './kit.ts';
import {
  BEACON,
  BUILDER_API,
  BUILDER_UI,
  BUILDER_UI_TOP,
  INBOX,
  INBOX_FIRST_ROW_Y,
  INBOX_FOOT,
  getTopOf,
} from './layout.ts';
import { SceneDefs } from './scene-defs.tsx';

const orchestrator = buildTerminal({
  title: 'orchestrator · laptop',
  box: { x: 24, y: 102, width: 300 },
  status: 'ready',
});

const builderAPI = buildTerminal({
  title: 'builder-api · impz',
  box: { x: 724, y: 132, width: 256 },
  status: { text: 'working', tone: 'teal' },
  lines: ['› /orders API'],
});

const builderUI = buildTerminal({
  title: 'builder-ui · sprites',
  box: { x: 470, y: 448, width: 274 },
  opens: 'spawnLanded',
  status: { text: 'starting', tone: 'violet' },
});

const inbox = buildInbox(undefined);

// A text that two terminals show is written once.
const ask = '/orders shape?';
const answer = '[{ id, total }]';

// An event rises from builder-ui through the beacon into the inbox, and a clearance comes back.
const eventStops = [BUILDER_UI_TOP, BEACON, INBOX_FOOT];
const clearanceStops = [INBOX_FOOT, BEACON, BUILDER_UI_TOP];

// Work moves directly between the islands and never touches the tower.
const uiLid = getTopOf(BUILDER_UI);
const apiLid = getTopOf(BUILDER_API);

const askPath = buildBowedPath(
  { x: uiLid.x + 6, y: uiLid.y },
  { x: apiLid.x - 4, y: apiLid.y },
  -14,
);

const answerPath = buildBowedPath(
  { x: apiLid.x - 6, y: apiLid.y + 4 },
  { x: uiLid.x + 10, y: uiLid.y + 4 },
  -6,
);

const gateRow = { x: INBOX.x + 146, y: INBOX_FIRST_ROW_Y };

export default defineScene({
  out: 'docs/assets/hero',
  stageS: 6,
  card: { width: 1000, height: 620, cornerRadius: 12 },
  description:
    'An animated diagram of atc. You ask an orchestrator on your laptop for an orders page, and it spawns builder-ui on a sprite. builder-ui asks builder-api, on an imp microVM, what the API returns. When builder-ui needs approval to deploy, the request rises through the atc gateway into your inbox. You clear it, and builder-ui deploys a preview.',
  styles: {
    face: {
      fill: getColor('white'),
      'fill-opacity': 0.92,
      'font-size': 12.5,
      'font-weight': 700,
      'letter-spacing': '.14em',
    },
    facesub: {
      fill: getColor('white'),
      'fill-opacity': 0.62,
      'font-size': 11,
      'letter-spacing': '.03em',
    },
    name: { fill: getColor('text'), 'font-size': 12.5, 'font-weight': 700 },
    status: { 'font-size': 11 },
    row: { fill: getColor('text'), 'font-size': 12 },
    rowev: { 'font-size': 12 },
  },
  render: () => (
    <>
      <SceneDefs />
      <Backdrop />
      <Islands />
      {orchestrator}
      {builderAPI}
      {builderUI}
      {inbox}

      <Stage caption="You ask your orchestrator for an orders page.">
        <Type id="prompt" on={orchestrator} typing={{ steps: 3 }} sends={{ steps: 4 }}>
          build the orders page on a sprite
        </Type>
        <Status on={orchestrator} at="prompt.sent">
          thinking
        </Status>
        <Beat id="reply">
          <Line on={orchestrator}>On it.</Line>
          <Status on={orchestrator} tone="teal">
            working
          </Status>
        </Beat>
      </Stage>

      <Stage caption="It spawns a builder on another machine.">
        <Beat id="spawnLine">
          <Line on={orchestrator} tone="violet" head="• spawn builder-ui:">
            {''}
          </Line>
        </Beat>
        <Beat id="spawnTask">
          <Line on={orchestrator} tone="violet" head={'\u00A0\u00A0'}>
            build the orders UI
          </Line>
          <Status on={orchestrator} tone="violet">
            spawning
          </Status>
        </Beat>
        <Beat id="spawnLanded" focus={builderUI}>
          <Status on={orchestrator} tone="teal">
            working
          </Status>
        </Beat>
        <Line id="uiLine" on={builderUI}>
          › build the orders UI
        </Line>
        <Status on={builderUI} at="uiLine" tone="teal">
          working
        </Status>
        <Beat id="ev1" focus={inbox}>
          <Pulse stops={eventStops} tone="violet" />
        </Beat>
      </Stage>

      <Stage caption="Agents talk to each other directly.">
        <Beat id="askLine">
          <Line on={builderUI} head="→ builder-api: " tone="blue">
            {ask}
          </Line>
          <Status on={builderUI} tone="blue">
            asking
          </Status>
        </Beat>
        <Beat id="askLanded">
          <Flight path={askPath} tone="blue" />
          <Line on={builderAPI} head="← builder-ui: " tone="blue">
            {ask}
          </Line>
          <Status on={builderAPI}>thinking</Status>
        </Beat>
        <Line id="answerLine" on={builderAPI} head="→ builder-ui: " tone="blue">
          {answer}
        </Line>
        <Status on={builderAPI} at="answerLine" tone="teal">
          working
        </Status>
        <Beat id="answerLanded">
          <Flight path={answerPath} tone="blue" />
          <Line on={builderUI} head="← builder-api: " tone="blue">
            {answer}
          </Line>
          <Status on={builderUI} tone="teal">
            working
          </Status>
        </Beat>
      </Stage>

      <Stage caption="A request for you lands in your inbox.">
        <Beat id="need">
          <Status on={builderUI} tone="amber" read>
            needs you
          </Status>
          <Alert on={builderUI} tone="amber" until="clear" />
        </Beat>
        <Beat id="needLanded" focus={inbox}>
          <Pulse stops={eventStops} tone="amber" />
        </Beat>
      </Stage>

      <Stage caption="You clear it there, whichever agent asked.">
        <Beat id="clear">
          <Cursor
            from={{ x: 982, y: INBOX.y + 30 }}
            target={{ x: gateRow.x + 4, y: gateRow.y + 2 }}
            glide={{ steps: 2 }}
            leaves="clear"
          />
          <Stamp point={gateRow} tone="green" until="result">
            CLEARED
          </Stamp>
        </Beat>
        <Beat id="cleared">
          <Pulse stops={clearanceStops} tone="green" />
          <Status on={builderUI} tone="green">
            cleared
          </Status>
        </Beat>
      </Stage>

      <Stage caption="The builder deploys and carries on.">
        <Beat id="deploy">
          <Line on={builderUI} tone="green">
            • deploy preview
          </Line>
          <Status on={builderUI} tone="teal">
            working
          </Status>
        </Beat>
        <Line id="result" on={builderUI} tone="green">
          ✓ preview live
        </Line>
        <Beat id="ev3" focus={inbox}>
          <Pulse stops={eventStops} tone="green" />
        </Beat>
      </Stage>
    </>
  ),
});
