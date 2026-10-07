import { expect, test } from 'bun:test';
import { buildMockMirrorSession } from '../test-utils/build-mock-mirror-session';
import { buildStubTerminal } from '../test-utils/build-stub-terminal';
import { KEYS } from '../test-utils/keys';
import { planOverlayColumns } from './plan-overlay-columns';
import type { OverlayColumnPlan } from './plan-overlay-columns';
import { buildOverlayHint, buildSessionRow, drawOverlay } from './ui';
import type { OverlayView } from './ui';

test('#buildOverlayHint includes headless on a row whose agent can run a headless turn', () => {
  expect(
    buildOverlayHint(
      buildMockMirrorSession({
        state: 'running',
        alive: true,
        kind: 'pty',
        canEject: true,
        agent: 'claude',
        pinned: false,
      }),
    ),
  ).toBe('⏎ attach · H headless · y yank · Y eject · K kill · p pin ▏ g groups · n new · ? keys');
});

test('#buildOverlayHint omits headless and keeps yank on a Grok row, whose agent cannot run a headless turn', () => {
  expect(
    buildOverlayHint(
      buildMockMirrorSession({
        state: 'running',
        alive: true,
        kind: 'pty',
        canEject: false,
        agent: 'grok',
        pinned: false,
      }),
    ),
  ).toBe('⏎ attach · y yank · Y eject · K kill · p pin ▏ g groups · n new · ? keys');
});

test('#buildOverlayHint points the pin action of a sub-session at its parent', () => {
  const parent = buildMockMirrorSession({
    id: 'wrangler',
    parent: null,
    state: 'running',
    alive: true,
    kind: 'pty',
    canEject: true,
    agent: 'claude',
    pinned: true,
  });

  const child = buildMockMirrorSession({
    id: 'worker',
    parent: 'wrangler',
    state: 'running',
    alive: true,
    kind: 'pty',
    canEject: true,
    agent: 'claude',
    pinned: false,
  });

  expect(buildOverlayHint(child, [parent, child])).toBe(
    '⏎ attach · H headless · y yank · Y eject · K kill · p unpin parent ▏ g groups · n new · ? keys',
  );
});

test('#buildOverlayHint keeps the plain pin action on a top-level session', () => {
  const session = buildMockMirrorSession({
    id: 'auth',
    parent: null,
    state: 'running',
    alive: true,
    kind: 'pty',
    canEject: true,
    agent: 'claude',
    pinned: false,
  });

  expect(buildOverlayHint(session, [session])).toBe(
    '⏎ attach · H headless · y yank · Y eject · K kill · p pin ▏ g groups · n new · ? keys',
  );
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
    buildMockMirrorSession({
      name: 'auth',
      state: 'running',
      unread: false,
      lastMsg: 'started',
      agent: 'zai',
      pinned: false,
      target: 'local',
      model: null,
      harness: 'running',
    }),
    plan,
    view,
    false,
  );

  expect(row).toMatchInlineSnapshot(`
    {
      "styled": "\u001B[36m◐\u001B[0m   auth             GLM (z.ai) running   started",
      "width": 49,
    }
  `);
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
    buildMockMirrorSession({
      name: 'auth',
      state: 'running',
      unread: false,
      lastMsg: 'started',
      agent: 'zai',
      pinned: false,
      target: 'local',
      model: 'opus',
      harness: 'running',
    }),
    plan,
    view,
    false,
  );

  expect(row).toMatchInlineSnapshot(`
    {
      "styled": "\u001B[36m◐\u001B[0m   auth             GLM (… glm-5.3  running   started",
      "width": 54,
    }
  `);
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
    buildMockMirrorSession({
      name: 'auth',
      state: 'running',
      unread: false,
      lastMsg: 'started',
      agent: 'zai',
      pinned: false,
      target: 'local',
      model: 'opus',
      harness: 'running',
    }),
    plan,
    view,
    false,
  );

  expect(row).toMatchInlineSnapshot(`
    {
      "styled": "\u001B[36m◐\u001B[0m   auth             GLM (… opus     running   started",
      "width": 54,
    }
  `);
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
    buildMockMirrorSession({
      name: 'auth',
      state: 'running',
      unread: false,
      lastMsg: 'started',
      agent: 'claude',
      pinned: false,
      target: 'local',
      model: null,
      harness: 'running',
    }),
    plan,
    view,
    false,
  );

  expect(row).toMatchInlineSnapshot(`
    {
      "styled": "\u001B[36m◐\u001B[0m   auth             local Claude running   started",
      "width": 51,
    }
  `);
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
    buildMockMirrorSession({
      name: 'auth',
      state: 'running',
      unread: false,
      lastMsg: 'started',
      agent: 'claude',
      pinned: false,
      target: 'imp-box',
      model: null,
      harness: 'running',
    }),
    plan,
    view,
    false,
  );

  expect(row).toMatchInlineSnapshot(`
    {
      "styled": "\u001B[36m◐\u001B[0m   auth             Claude running   started",
      "width": 45,
    }
  `);
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
    buildMockMirrorSession({
      name: 'auth',
      state: 'needs_you',
      unread: false,
      lastMsg: 'asleep',
      agent: 'claude',
      pinned: false,
      target: 'local',
      model: null,
      harness: 'suspended',
    }),
    plan,
    view,
    false,
  );

  expect(row).toMatchInlineSnapshot(`
    {
      "styled": "\u001B[31m●\u001B[0m   auth             Claude suspended asleep         ",
      "width": 53,
    }
  `);
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
    buildMockMirrorSession({
      name: 'auth',
      state: 'running',
      unread: false,
      lastMsg: 'started',
      agent: 'claude',
      pinned: false,
      target: 'local',
      model: null,
      harness: 'running',
    }),
    plan,
    view,
    true,
  );

  expect(row).toMatchInlineSnapshot(`
    {
      "styled": "\u001B[36m◐\u001B[0m   \u001B[7mauth             Claude running   started\u001B[0m",
      "width": 45,
    }
  `);
});

test('#buildSessionRow draws the harness and no model in a narrow grouped overlay', () => {
  const plan = planOverlayColumns({
    innerWidth: 48,
    grouped: true,
    showTarget: true,
    targetMax: 5,
    harnessMax: 6,
    modelMax: 8,
  });

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
    buildMockMirrorSession({
      name: 'auth',
      state: 'running',
      unread: false,
      lastMsg: 'started',
      agent: 'claude',
      pinned: false,
      target: 'local',
      model: 'opus',
      harness: 'running',
    }),
    plan,
    view,
    false,
  );

  expect(row).toMatchInlineSnapshot(`
    {
      "styled": "\u001B[36m◐\u001B[0m   auth             local Claude running   sta…",
      "width": 48,
    }
  `);
});

test('#drawOverlay draws session rows inside the overlay box borders', () => {
  const terminal = buildStubTerminal();

  drawOverlay(
    {
      sessions: [
        buildMockMirrorSession({
          name: 'auth',
        }),
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
    terminal.write,
  );

  const drawnRows = terminal
    .getText()
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
    buildMockMirrorSession({
      name: 'auth',
      state: 'running',
      unread: false,
      lastMsg: 'started',
      agent: 'constructor',
      pinned: false,
      target: 'local',
      model: null,
      harness: 'running',
    }),
    plan,
    view,
    false,
  );

  expect(row).toMatchInlineSnapshot(`
    {
      "styled": "\u001B[36m◐\u001B[0m   auth             constructor running   started",
      "width": 50,
    }
  `);
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
    buildMockMirrorSession({
      name: 'auth',
      state: 'running',
      unread: false,
      lastMsg: 'started',
      agent: 'claude',
      pinned: false,
      target: 'local',
      model: 'constructor',
      harness: 'running',
    }),
    plan,
    view,
    false,
  );

  expect(row).toMatchInlineSnapshot(`
    {
      "styled": "\u001B[36m◐\u001B[0m   auth             Claude constructor  running   started",
      "width": 58,
    }
  `);
});
