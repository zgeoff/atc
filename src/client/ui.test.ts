import { expect, test } from 'bun:test';
import { planOverlayColumns } from './plan-overlay-columns';
import type { OverlayColumnPlan } from './plan-overlay-columns';
import { buildOverlayHint, buildSessionRow } from './ui';
import type { OverlaySessionView, OverlayView } from './ui';

const liveClaude: OverlaySessionView = {
  id: 'auth',
  parent: null,
  name: 'auth',
  cwd: '/x',
  state: 'running',
  unread: false,
  lastMsg: 'started',
  alive: true,
  kind: 'pty',
  resumable: true,
  canEject: true,
  agent: 'claude',
  pinned: false,
  repoRoot: '/x',
  target: 'local',
  model: null,
  harness: 'running',
};

test('it includes headless on a row whose agent can run a headless turn', () => {
  expect(buildOverlayHint(liveClaude)).toInclude('H headless');
});

test('it omits headless on a row whose agent cannot run one', () => {
  expect(buildOverlayHint({ ...liveClaude, agent: 'grok', canEject: false })).not.toInclude('H');
});

test('it still names yank on a live Grok row', () => {
  expect(buildOverlayHint({ ...liveClaude, agent: 'grok', canEject: false })).toInclude('y yank');
});

test('it points the pin action of a sub-session at its parent', () => {
  const parent: OverlaySessionView = { ...liveClaude, id: 'wrangler', pinned: true };
  const child: OverlaySessionView = { ...liveClaude, id: 'worker', parent: 'wrangler' };

  expect(buildOverlayHint(child, [parent, child])).toInclude('p unpin parent');
});

test('it keeps the plain pin action on a top-level session', () => {
  expect(buildOverlayHint(liveClaude, [liveClaude])).toInclude('p pin ');
});

test('it labels a gateway row with its readable harness name', () => {
  const plan: OverlayColumnPlan = {
    nameWidth: 16,
    dirWidth: 0,
    targetWidth: 0,
    harnessWidth: 10,
    modelWidth: 0,
    lifecycleWidth: 9,
    eventWidth: 7,
  };

  const view: OverlayView = {
    sessions: [],
    agentLabels: { zai: 'GLM (z.ai)' },
    agentModels: {},
    showTarget: false,
    selected: 0,
    confirmKill: false,
    confirmDestroy: false,
    filter: null,
    stale: false,
    grouped: true,
  };

  const row = buildSessionRow({ ...liveClaude, agent: 'zai' }, plan, view, false);

  expect(row.styled).toInclude('GLM (z.ai)');
});

test('it resolves a model alias through the daemon answer map', () => {
  const plan: OverlayColumnPlan = {
    nameWidth: 16,
    dirWidth: 0,
    targetWidth: 0,
    harnessWidth: 6,
    modelWidth: 8,
    lifecycleWidth: 9,
    eventWidth: 7,
  };

  const view: OverlayView = {
    sessions: [],
    agentLabels: { zai: 'GLM (z.ai)' },
    agentModels: { zai: { opus: 'glm-5.3' } },
    showTarget: false,
    selected: 0,
    confirmKill: false,
    confirmDestroy: false,
    filter: null,
    stale: false,
    grouped: true,
  };

  const row = buildSessionRow({ ...liveClaude, agent: 'zai', model: 'opus' }, plan, view, false);

  expect(row.styled).toInclude('glm-5.3');
});

test('it falls back to the raw model string when the alias map has no entry', () => {
  const plan: OverlayColumnPlan = {
    nameWidth: 16,
    dirWidth: 0,
    targetWidth: 0,
    harnessWidth: 6,
    modelWidth: 8,
    lifecycleWidth: 9,
    eventWidth: 7,
  };

  const view: OverlayView = {
    sessions: [],
    agentLabels: { zai: 'GLM (z.ai)' },
    agentModels: {},
    showTarget: false,
    selected: 0,
    confirmKill: false,
    confirmDestroy: false,
    filter: null,
    stale: false,
    grouped: true,
  };

  const row = buildSessionRow({ ...liveClaude, agent: 'zai', model: 'opus' }, plan, view, false);

  expect(row.styled).toInclude('opus');
});

test('it shows the target column when several targets are available even if every row uses one', () => {
  const plan: OverlayColumnPlan = {
    nameWidth: 16,
    dirWidth: 0,
    targetWidth: 5,
    harnessWidth: 6,
    modelWidth: 0,
    lifecycleWidth: 9,
    eventWidth: 7,
  };

  const view: OverlayView = {
    sessions: [],
    agentLabels: { claude: 'Claude' },
    agentModels: {},
    showTarget: true,
    selected: 0,
    confirmKill: false,
    confirmDestroy: false,
    filter: null,
    stale: false,
    grouped: true,
  };

  const row = buildSessionRow({ ...liveClaude, target: 'local' }, plan, view, false);

  expect(row.styled).toInclude('local');
});

test('it hides the target column when a single target is available', () => {
  const plan: OverlayColumnPlan = {
    nameWidth: 16,
    dirWidth: 0,
    targetWidth: 0,
    harnessWidth: 6,
    modelWidth: 0,
    lifecycleWidth: 9,
    eventWidth: 7,
  };

  const view: OverlayView = {
    sessions: [],
    agentLabels: { claude: 'Claude' },
    agentModels: {},
    showTarget: false,
    selected: 0,
    confirmKill: false,
    confirmDestroy: false,
    filter: null,
    stale: false,
    grouped: true,
  };

  const row = buildSessionRow({ ...liveClaude, target: 'imp-box' }, plan, view, false);

  expect(row.styled).not.toInclude('imp-box');
});

test('it keeps the harness lifecycle distinct from the attention state', () => {
  const plan: OverlayColumnPlan = {
    nameWidth: 16,
    dirWidth: 0,
    targetWidth: 0,
    harnessWidth: 6,
    modelWidth: 0,
    lifecycleWidth: 9,
    eventWidth: 15,
  };

  const view: OverlayView = {
    sessions: [],
    agentLabels: { claude: 'Claude' },
    agentModels: {},
    showTarget: false,
    selected: 0,
    confirmKill: false,
    confirmDestroy: false,
    filter: null,
    stale: false,
    grouped: true,
  };

  const row = buildSessionRow(
    { ...liveClaude, state: 'needs_you', harness: 'suspended', lastMsg: 'asleep' },
    plan,
    view,
    false,
  );

  expect(row.styled).toInclude('suspended');
  expect(row.styled).toInclude('asleep');
});

test('it highlights the selected row with inverse video', () => {
  const plan: OverlayColumnPlan = {
    nameWidth: 16,
    dirWidth: 0,
    targetWidth: 0,
    harnessWidth: 6,
    modelWidth: 0,
    lifecycleWidth: 9,
    eventWidth: 7,
  };

  const view: OverlayView = {
    sessions: [],
    agentLabels: { claude: 'Claude' },
    agentModels: {},
    showTarget: false,
    selected: 0,
    confirmKill: false,
    confirmDestroy: false,
    filter: null,
    stale: false,
    grouped: true,
  };

  const row = buildSessionRow(liveClaude, plan, view, true);

  expect(row.styled).toInclude('\u001B[7m');
});

test('it crowds the model out before the harness under width pressure', () => {
  const narrow = planOverlayColumns({
    innerWidth: 48,
    grouped: true,
    showTarget: true,
    targetMax: 5,
    harnessMax: 6,
    modelMax: 8,
  });

  const plan: OverlayColumnPlan = {
    nameWidth: narrow.nameWidth,
    dirWidth: narrow.dirWidth,
    targetWidth: narrow.targetWidth,
    harnessWidth: narrow.harnessWidth,
    modelWidth: narrow.modelWidth,
    lifecycleWidth: narrow.lifecycleWidth,
    eventWidth: narrow.eventWidth,
  };

  const view: OverlayView = {
    sessions: [],
    agentLabels: { claude: 'Claude' },
    agentModels: { claude: { opus: 'sonnet-x' } },
    showTarget: true,
    selected: 0,
    confirmKill: false,
    confirmDestroy: false,
    filter: null,
    stale: false,
    grouped: true,
  };

  const row = buildSessionRow({ ...liveClaude, model: 'opus' }, plan, view, false);

  expect(narrow.modelWidth).toBe(0);
  expect(row.styled).toInclude('Claude');
  expect(row.styled).not.toInclude('sonnet-x');
});
