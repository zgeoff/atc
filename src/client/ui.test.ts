import { expect, test } from 'bun:test';
import { KEYS } from '../test-utils/keys';
import type { OverlayColumnPlan } from './plan-overlay-columns';
import { buildOverlayHint, buildSessionRow, drawOverlay } from './ui';
import type { OverlaySessionView, OverlayView } from './ui';

test('#buildOverlayHint includes headless on a row whose agent can run a headless turn', () => {
  expect(
    buildOverlayHint({
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
    }),
  ).toInclude('H headless');
});

test('#buildOverlayHint omits headless on a row whose agent cannot run one', () => {
  expect(
    buildOverlayHint({
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
      canEject: false,
      agent: 'grok',
      pinned: false,
      repoRoot: '/x',
      target: 'local',
      model: null,
      harness: 'running',
    }),
  ).not.toInclude('H');
});

test('#buildOverlayHint still names yank on a live Grok row', () => {
  expect(
    buildOverlayHint({
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
      canEject: false,
      agent: 'grok',
      pinned: false,
      repoRoot: '/x',
      target: 'local',
      model: null,
      harness: 'running',
    }),
  ).toInclude('y yank');
});

test('#buildOverlayHint points the pin action of a sub-session at its parent', () => {
  const parent: OverlaySessionView = {
    id: 'wrangler',
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
    pinned: true,
    repoRoot: '/x',
    target: 'local',
    model: null,
    harness: 'running',
  };

  const child: OverlaySessionView = {
    id: 'worker',
    parent: 'wrangler',
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

  expect(buildOverlayHint(child, [parent, child])).toInclude('p unpin parent');
});

test('#buildOverlayHint keeps the plain pin action on a top-level session', () => {
  const session: OverlaySessionView = {
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

  expect(buildOverlayHint(session, [session])).toInclude('p pin ');
});

test('#buildSessionRow labels a gateway row with its readable harness name', () => {
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

  const row = buildSessionRow(
    {
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
      agent: 'zai',
      pinned: false,
      repoRoot: '/x',
      target: 'local',
      model: null,
      harness: 'running',
    },
    plan,
    view,
    false,
  );

  expect(row.styled).toInclude('GLM (z.ai)');
});

test('#buildSessionRow resolves a model alias through the daemon answer map', () => {
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

  const row = buildSessionRow(
    {
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
      agent: 'zai',
      pinned: false,
      repoRoot: '/x',
      target: 'local',
      model: 'opus',
      harness: 'running',
    },
    plan,
    view,
    false,
  );

  expect(row.styled).toInclude('glm-5.3');
});

test('#buildSessionRow falls back to the raw model string when the alias map has no entry', () => {
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

  const row = buildSessionRow(
    {
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
      agent: 'zai',
      pinned: false,
      repoRoot: '/x',
      target: 'local',
      model: 'opus',
      harness: 'running',
    },
    plan,
    view,
    false,
  );

  expect(row.styled).toInclude('opus');
});

test('#buildSessionRow shows the target column when several targets are available even if every row uses one', () => {
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

  const row = buildSessionRow(
    {
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
    },
    plan,
    view,
    false,
  );

  expect(row.styled).toInclude('local');
});

test('#buildSessionRow hides the target column when a single target is available', () => {
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

  const row = buildSessionRow(
    {
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
      target: 'imp-box',
      model: null,
      harness: 'running',
    },
    plan,
    view,
    false,
  );

  expect(row.styled).not.toInclude('imp-box');
});

test('#buildSessionRow keeps the harness lifecycle distinct from the attention state', () => {
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
    {
      id: 'auth',
      parent: null,
      name: 'auth',
      cwd: '/x',
      state: 'needs_you',
      unread: false,
      lastMsg: 'asleep',
      alive: true,
      kind: 'pty',
      resumable: true,
      canEject: true,
      agent: 'claude',
      pinned: false,
      repoRoot: '/x',
      target: 'local',
      model: null,
      harness: 'suspended',
    },
    plan,
    view,
    false,
  );

  expect(row.styled).toInclude('suspended');
  expect(row.styled).toInclude('asleep');
});

test('#buildSessionRow highlights the selected row with inverse video', () => {
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

  const row = buildSessionRow(
    {
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
    },
    plan,
    view,
    true,
  );

  expect(row.styled).toInclude('\u001B[7m');
});

test('#buildSessionRow draws the harness and no model when the plan leaves the model no width', () => {
  const plan: OverlayColumnPlan = {
    nameWidth: 16,
    dirWidth: 0,
    targetWidth: 5,
    harnessWidth: 6,
    modelWidth: 0,
    lifecycleWidth: 9,
    eventWidth: 4,
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

  const row = buildSessionRow(
    {
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
      model: 'opus',
      harness: 'running',
    },
    plan,
    view,
    false,
  );

  expect(row.styled).toInclude('Claude');
  expect(row.styled).not.toInclude('sonnet-x');
});

test('#drawOverlay draws session rows inside the overlay box borders', () => {
  const writes: string[] = [];

  drawOverlay(
    {
      sessions: [
        {
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
        },
      ],
      agentLabels: { claude: 'Claude' },
      agentModels: {},
      showTarget: false,
      selected: 0,
      confirmKill: false,
      confirmDestroy: false,
      filter: null,
      stale: false,
      grouped: true,
    },
    (chunk) => {
      writes.push(chunk);
    },
  );

  const drawnRows = writes
    .join('')
    .replaceAll(KEYS.esc, '')
    .split(/\[[0-9;]+H/u)
    .map((row) => row.replaceAll(/\[[0-9;?]*[A-Za-z]/gu, '').trim());

  expect(drawnRows).toSatisfyAny((row: string) => /^│.*auth.*│$/u.test(row));
});

test('#buildSessionRow falls back to the raw id when the harness name would hit an inherited property', () => {
  const plan: OverlayColumnPlan = {
    nameWidth: 16,
    dirWidth: 0,
    targetWidth: 0,
    harnessWidth: 11,
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

  const row = buildSessionRow(
    {
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
      agent: 'constructor',
      pinned: false,
      repoRoot: '/x',
      target: 'local',
      model: null,
      harness: 'running',
    },
    plan,
    view,
    false,
  );

  expect(row.styled).toInclude('constructor');
});

test('#buildSessionRow falls back to the raw model when the alias would hit an inherited property', () => {
  const plan: OverlayColumnPlan = {
    nameWidth: 16,
    dirWidth: 0,
    targetWidth: 0,
    harnessWidth: 6,
    modelWidth: 12,
    lifecycleWidth: 9,
    eventWidth: 7,
  };

  const view: OverlayView = {
    sessions: [],
    agentLabels: { claude: 'Claude' },
    agentModels: { claude: { opus: 'glm-5.3' } },
    showTarget: false,
    selected: 0,
    confirmKill: false,
    confirmDestroy: false,
    filter: null,
    stale: false,
    grouped: true,
  };

  const row = buildSessionRow(
    {
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
      model: 'constructor',
      harness: 'running',
    },
    plan,
    view,
    false,
  );

  expect(row.styled).toInclude('constructor');
});
