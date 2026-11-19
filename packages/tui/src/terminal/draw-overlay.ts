import type { AgentID } from '@atc/core';
import { PINNED_GROUP_KEY } from '@atc/protocol';
import type { SessionState } from '@atc/protocol';
import type { AgentMetadata } from '../fleet/resolve-agent-metadata';
import type { DaemonName } from '../fleet/session-key';
import type { HarnessLifecycle } from '../fleet/to-mirror-session';
import { pickPinTarget } from '../overlay/pick-pin-target';
import { planOverlayColumns } from '../overlay/plan-overlay-columns';
import type { OverlayColumnPlan } from '../overlay/plan-overlay-columns';
import { cols } from './cols';
import { boxBottom, boxDivider, boxRow, boxTop, dimRow, drawBox } from './draw-box';
import { formatDir } from './pick-matches';
import { truncate } from './truncate';
import type { Row } from './types';
import { writeOut } from './write-out';

// The slice of a session the drawing layer needs; satisfied by both the
// daemon's sessions and the wire descriptors a client mirrors.
interface SessionView {
  readonly name: string;
  readonly cwd: string;
  readonly state: SessionState;
  readonly unread: boolean;
  readonly lastMsg: string;
}

const ESC = '\u001B';

const GLYPH: Record<SessionState, string> = {
  needs_you: `${ESC}[31m●${ESC}[0m`,
  running: `${ESC}[36m◐${ESC}[0m`,
  done: `${ESC}[32m✓${ESC}[0m`,
  exited: `${ESC}[90m✗${ESC}[0m`,
};

// borders included; an item row holds 4 columns fewer.
export function getPickerWidth(): number {
  return Math.min(cols() - 4, 90);
}

// Selection-dependent hints need the liveness facts of each row.
export interface OverlaySessionView extends SessionView {
  // The daemon that holds the session; a sub-session nests under a parent of the same daemon.
  readonly daemon: DaemonName;
  readonly id: string;
  readonly parent: string | null;
  readonly alive: boolean;
  readonly kind: 'pty' | 'headless';
  readonly resumable: boolean;
  readonly canEject: boolean;
  readonly agent: AgentID;
  readonly pinned: boolean;
  readonly repoRoot: string;
  readonly target: string;
  readonly model: string | null;

  // Where the session's harness stands, apart from the attention its state
  // carries: running, suspended inside a sleeping host, or exited.
  readonly harness: HarnessLifecycle;
}

export interface OverlayView {
  sessions: readonly OverlaySessionView[];

  // The readable name per agent id, and each agent's tier-alias map, from
  // the daemon's `agents.list` answer over the config.
  agentLabels: Readonly<Record<AgentID, string>>;
  agentModels: Readonly<Record<AgentID, Readonly<Record<string, string>>>>;

  // What a remote daemon's own answer says about its agents, which its rows read in place of the
  // two maps above.
  remoteAgents?: ReadonlyMap<string, AgentMetadata>;

  // Whether a column names each row's daemon, as it does while the client links to several.
  showDaemon?: boolean;

  // One line for each daemon whose link is not up, drawn under the rows.
  daemonLines?: readonly string[];

  // Whether more than one execution target is available to spawn on, which
  // is what brings the target column in.
  showTarget: boolean;
  selected: number;
  confirmKill: boolean;

  // A kill the daemon refused because forgetting the session destroys its
  // host waits on a second confirm.
  confirmDestroy: boolean;
  filter: string | null;

  // Shown on the hint line in place of the hints, under any confirm prompt.
  notice: string | null;
  stale: boolean;
  grouped: boolean;
}

// A session row draws status (the attention glyph plus the unread mark),
// pin, name, the flat view's directory, then the target, harness, model,
// harness lifecycle, and last event columns the width plan allows.
export function buildSessionRow(
  session: Readonly<OverlaySessionView>,
  plan: Readonly<OverlayColumnPlan>,
  view: Readonly<OverlayView>,
  sel: boolean,
): Row {
  const sub = isSubSession(session, view.sessions);
  const metadata = pickAgentMetadata(view, session.daemon);
  const daemonWidth = getDaemonWidth(view);

  const daemon =
    daemonWidth > 0 ? truncate(session.daemon ?? '', daemonWidth).padEnd(daemonWidth) : '';

  const name =
    plan.nameWidth >= 4 && sub
      ? `↳ ${truncate(session.name, plan.nameWidth - 2)}`.padEnd(plan.nameWidth)
      : truncate(session.name, plan.nameWidth).padEnd(plan.nameWidth);

  const directory =
    plan.dirWidth > 0 ? truncate(formatDir(session.cwd), plan.dirWidth).padEnd(plan.dirWidth) : '';

  const target =
    plan.targetWidth > 0 ? truncate(session.target, plan.targetWidth).padEnd(plan.targetWidth) : '';

  const label = findMapValue(metadata.labels, session.agent) ?? session.agent;
  const harness = truncate(label, plan.harnessWidth).padEnd(plan.harnessWidth);

  const resolved =
    session.model === null ? '' : resolveModelAlias(metadata.models, session.agent, session.model);

  const model =
    plan.modelWidth > 0 ? truncate(resolved, plan.modelWidth).padEnd(plan.modelWidth) : '';

  const lifecycle = truncate(session.harness, plan.lifecycleWidth).padEnd(plan.lifecycleWidth);
  const event = truncate(session.lastMsg, plan.eventWidth).padEnd(plan.eventWidth);

  const cells = [daemon, name, directory, target, harness, model, lifecycle, event].filter(
    (cell) => cell !== '',
  );

  const body = cells.join(' ');
  const styledBody = sel ? `${ESC}[7m${body}${ESC}[0m` : body;
  const unread = session.unread ? `${ESC}[1;33m!${ESC}[0m` : ' ';
  const pin = session.pinned ? `${ESC}[93m⋆${ESC}[0m` : ' ';

  return {
    styled: `${GLYPH[session.state]}${unread}${pin} ${styledBody}`,
    width: 4 + body.length,
  };
}

export function drawOverlay(view: OverlayView, write: (chunk: string) => void = writeOut) {
  const width = Math.min(cols() - 4, 90);
  const rowsList: Row[] = [boxTop(width, 'sessions')];

  if (view.sessions.length === 0) {
    const empty = view.filter === null ? 'no sessions — n to spawn' : 'no matches';

    rowsList.push(dimRow(width, empty));
  }

  // The harness label and the model each row would draw, so the columns
  // take the width of what is actually on screen.
  const harnessMax = Math.max(
    0,
    ...view.sessions.map(
      (session) =>
        (
          findMapValue(pickAgentMetadata(view, session.daemon).labels, session.agent) ??
          session.agent
        ).length,
    ),
  );

  const modelMax = Math.max(
    0,
    ...view.sessions.map((session) => {
      if (session.model === null) {
        return 0;
      }

      return resolveModelAlias(
        pickAgentMetadata(view, session.daemon).models,
        session.agent,
        session.model,
      ).length;
    }),
  );

  const targetMax = Math.max(0, ...view.sessions.map((session) => session.target.length));
  const daemonWidth = getDaemonWidth(view);

  const plan = planOverlayColumns({
    innerWidth: width - 4 - (daemonWidth > 0 ? daemonWidth + 1 : 0),
    grouped: view.grouped,
    showTarget: view.showTarget,
    targetMax,
    harnessMax,
    modelMax,
  });

  // the grouped view clusters sessions under dim repository headers, pinned ones first;
  // the flat view shows a directory column instead. A sub-session row follows its parent
  // indented and never opens a header.
  let lastKey: string | null = null;

  for (const [index, session] of view.sessions.entries()) {
    const sub = isSubSession(session, view.sessions);
    const key = session.pinned ? PINNED_GROUP_KEY : `${session.daemon ?? ''}\n${session.repoRoot}`;

    if (view.grouped && !sub && key !== lastKey) {
      lastKey = key;

      rowsList.push(dimRow(width, `▸ ${session.pinned ? 'pinned' : formatDir(session.repoRoot)}`));
    }

    const row = buildSessionRow(session, plan, view, index === view.selected);

    rowsList.push(boxRow(width, row.styled, row.width));
  }

  for (const line of view.daemonLines ?? []) {
    rowsList.push(dimRow(width, line));
  }

  rowsList.push(boxDivider(width));

  if (view.filter !== null) {
    const pattern = truncate(view.filter, width - 8);

    rowsList.push(
      boxRow(width, `/ ${pattern}${ESC}[93m█${ESC}[0m`, 2 + pattern.length + 1),
      boxDivider(width),
    );
  }

  const selected = view.sessions[view.selected];
  let hint = buildOverlayHint(selected, view.sessions);

  if (view.stale) {
    hint += ' · u update daemon';
  }

  if (view.filter !== null) {
    hint = 'type to filter · ↑↓ move · ⏎ attach · esc clear';
  }

  if (view.notice !== null) {
    hint = view.notice;
  }

  if (view.confirmKill) {
    hint = formatKillConfirm(selected, view.sessions);
  }

  if (view.confirmDestroy) {
    hint = 'forget destroys its host and everything on it? y / n';
  }

  rowsList.push(dimRow(width, hint), boxBottom(width));

  drawBox(rowsList, write);
}

// A daemon-supplied id or alias can name an inherited property, so map
// reads go through an own-property check instead of indexing blindly.
function findMapValue<V>(map: Readonly<Record<string, V>>, key: string): V | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

// The agent labels and models a row reads: its own daemon's answer, else the primary's.
function pickAgentMetadata(view: Readonly<OverlayView>, daemon: DaemonName): AgentMetadata {
  return (
    (daemon === null ? undefined : view.remoteAgents?.get(daemon)) ?? {
      labels: view.agentLabels,
      models: view.agentModels,
    }
  );
}

// A session's model as the row draws it: the daemon answer's alias target,
// or the raw model string when the answer maps nothing for it.
function resolveModelAlias(
  models: Readonly<Record<AgentID, Readonly<Record<string, string>>>>,
  agent: AgentID,
  model: string,
): string {
  const aliases = findMapValue(models, agent);

  return aliases === undefined ? model : (findMapValue(aliases, model) ?? model);
}

const DAEMON_COLUMN_MAX = 12;

// The width of the daemon column: 0 unless the list names daemons and one of its rows has a name.
function getDaemonWidth(view: Readonly<OverlayView>): number {
  if (view.showDaemon !== true) {
    return 0;
  }

  return Math.min(
    DAEMON_COLUMN_MAX,
    Math.max(0, ...view.sessions.map((session) => session.daemon?.length ?? 0)),
  );
}

function isSubSession(session: Readonly<OverlaySessionView>, list: readonly OverlaySessionView[]) {
  return (
    session.parent !== null &&
    list.some((x) => x.id === session.parent && x.daemon === session.daemon)
  );
}

// A kill acts on the selected session's whole set, so the confirm counts
// the live sub-sessions that go with it; a forget counts the dead ones.
function formatKillConfirm(
  session: OverlaySessionView | undefined,
  list: readonly OverlaySessionView[],
): string {
  const children =
    session === undefined
      ? []
      : list.filter((x) => x.parent === session.id && x.daemon === session.daemon);

  const affected = children.filter((x) => x.alive === (session?.alive ?? false));

  if (affected.length === 0) {
    return 'kill selected session? y / n';
  }

  const noun = affected.length === 1 ? 'sub-session' : 'sub-sessions';

  return `kill selected session and its ${affected.length} ${noun}? y / n`;
}

const GLOBAL_HINT = 'g groups · n new · ? keys';

// Only the actions valid for the selected row appear; the full reference
// lives behind ?. Grok has no headless handoff, so H is omitted there. A
// sub-session's pin action targets its parent.
export function buildOverlayHint(
  session: OverlaySessionView | undefined,
  list: readonly OverlaySessionView[] = [],
): string {
  if (session === undefined) {
    return GLOBAL_HINT;
  }

  const actions: string[] = [];

  if (session.kind === 'headless' && session.alive) {
    actions.push('P reattach', 'K kill');
  } else if (session.alive) {
    actions.push('⏎ attach');

    if (session.state === 'needs_you') {
      actions.push('a ack');
    }

    if (session.canEject) {
      actions.push('H headless');
    }

    actions.push('y yank', 'Y eject', 'K kill');
  } else {
    if (session.resumable) {
      actions.push('P revive', 'y yank');
    }

    actions.push('K forget');
  }

  const owner = pickPinTarget(session, list);
  const pinVerb = owner.pinned ? 'p unpin' : 'p pin';
  const pinAction = owner === session ? pinVerb : `${pinVerb} parent`;

  actions.push(pinAction);

  return `${actions.join(' · ')} ▏ ${GLOBAL_HINT}`;
}

export interface PickerView {
  title: string;
  items: readonly string[];
  selected: number;
  input: string;
  placeholder?: string;
  hint: string;

  // The indexes of items drawn dim: listed, but not a fit for the flow.
  dimmed?: ReadonlySet<number>;
}

const PICKER_WINDOW_ROWS = 10;

export function drawPicker(view: PickerView, write: (chunk: string) => void = writeOut) {
  const width = getPickerWidth();
  const rowsList: Row[] = [boxTop(width, view.title)];
  const visible = planPickerWindow(view.items.length, view.selected);

  if (visible.start > 0) {
    rowsList.push(dimRow(width, `↑ ${visible.start} more`));
  }

  for (const [offset, item] of view.items.slice(visible.start, visible.end).entries()) {
    const index = visible.start + offset;
    const sel = index === view.selected;
    const truncated = truncate(item, width - 4);
    const dim = view.dimmed?.has(index) === true;
    const inverse = sel ? `${ESC}[7m${truncated.padEnd(width - 4)}${ESC}[0m` : truncated;
    const styled = dim ? `${ESC}[90m${inverse}${ESC}[0m` : inverse;
    const plainLen = sel ? width - 4 : truncated.length;

    rowsList.push(boxRow(width, styled, plainLen));
  }

  if (visible.end < view.items.length) {
    rowsList.push(dimRow(width, `↓ ${view.items.length - visible.end} more`));
  }

  // The cursor always sits at the end of the input, so show the tail and
  // drop the head once the text outgrows the row.
  const inputMax = width - 8;

  const inputShown =
    view.input.length <= inputMax ? view.input : `…${view.input.slice(-(inputMax - 1))}`;

  let inputStyled: string;
  let inputLen: number;

  if (inputShown === '' && view.placeholder !== undefined && view.placeholder !== '') {
    const ph = truncate(view.placeholder, width - 8);

    inputStyled = `> ${ESC}[93m█${ESC}[0m${ESC}[90m ${ph}${ESC}[0m`;
    inputLen = 2 + 1 + 1 + ph.length;
  } else {
    inputStyled = `> ${inputShown}${ESC}[93m█${ESC}[0m`;
    inputLen = 2 + inputShown.length + 1;
  }

  rowsList.push(
    boxRow(width, inputStyled, inputLen),
    boxDivider(width),
    dimRow(width, view.hint),
    boxBottom(width),
  );

  drawBox(rowsList, write);
}

interface PickerWindow {
  readonly start: number;
  readonly end: number;
}

// Each count row takes the place of an item row, so a short terminal that fits
// the box with no count row fits it with both.
function planPickerWindow(count: number, selected: number): PickerWindow {
  if (count <= PICKER_WINDOW_ROWS) {
    return { start: 0, end: count };
  }

  const edgeItems = PICKER_WINDOW_ROWS - 1;

  if (selected < edgeItems) {
    return { start: 0, end: edgeItems };
  }

  const hiddenBelow = count - selected - 1;

  if (hiddenBelow <= 1) {
    return { start: count - edgeItems, end: count };
  }

  return { start: selected - edgeItems + 2, end: selected + 1 };
}
