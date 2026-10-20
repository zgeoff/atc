import { expect, test } from 'bun:test';
import { toAgentSessionID, toSessionID } from '@atc/core';
import { planGrokHookEvents } from './plan-grok-hook-events';

test('it starts a session with its summary as the name source and records the start', () => {
  expect(
    planGrokHookEvents(
      {
        atcId: toSessionID('s1'),
        event: 'SessionStart',
        payload: { sessionId: 'g1', cwd: '/tmp/proj' },
      },
      undefined,
      '/home/u/.grok',
    ),
  ).toStrictEqual({
    events: [
      {
        kind: 'started',
        agentSessionID: toAgentSessionID('g1'),
        nameSource: '/home/u/.grok/sessions/%2Ftmp%2Fproj/g1/summary.json',
      },
    ],
    next: { lastKind: 'started' },
  });
});

test('it reads a snake_case hook event name as its PascalCase hook', () => {
  expect(
    planGrokHookEvents(
      {
        atcId: toSessionID('s1'),
        event: 'session_start',
        payload: { sessionId: 'g1', cwd: '/tmp/proj' },
      },
      undefined,
      '/home/u/.grok',
    ).events,
  ).toStrictEqual([
    {
      kind: 'started',
      agentSessionID: toAgentSessionID('g1'),
      nameSource: '/home/u/.grok/sessions/%2Ftmp%2Fproj/g1/summary.json',
    },
  ]);
});

test('it records a submitted prompt as the latest prompt', () => {
  expect(
    planGrokHookEvents(
      {
        atcId: toSessionID('s1'),
        event: 'UserPromptSubmit',
        payload: { sessionId: 'g1', promptId: 'p2', prompt: 'next' },
      },
      { lastKind: 'turn-done', latestPromptID: 'p1' },
      '/home/u/.grok',
    ),
  ).toStrictEqual({
    events: [
      {
        kind: 'prompt-submitted',
        agentSessionID: toAgentSessionID('g1'),
        message: 'next',
        detail: 'next',
      },
    ],
    next: { lastKind: 'prompt-submitted', latestPromptID: 'p2' },
  });
});

test('it reads a stop for a prompt older than the latest submitted one as a heartbeat', () => {
  expect(
    planGrokHookEvents(
      {
        atcId: toSessionID('s1'),
        event: 'Stop',
        payload: { sessionId: 'g1', reason: 'end_turn', promptId: 'p1' },
      },
      { lastKind: 'prompt-submitted', latestPromptID: 'p2' },
      '/home/u/.grok',
    ),
  ).toStrictEqual({
    events: [{ kind: 'heartbeat', agentSessionID: toAgentSessionID('g1') }],
    next: { lastKind: 'prompt-submitted', latestPromptID: 'p2' },
  });
});

test('it reads a stop for the latest prompt as a finished turn', () => {
  expect(
    planGrokHookEvents(
      {
        atcId: toSessionID('s1'),
        event: 'Stop',
        payload: {
          sessionId: 'g1',
          cwd: '/tmp',
          reason: 'end_turn',
          promptId: 'p2',
          lastAssistantMessage: 'x'.repeat(700),
        },
      },
      { lastKind: 'prompt-submitted', latestPromptID: 'p2' },
      '/home/u/.grok',
    ),
  ).toStrictEqual({
    events: [
      {
        kind: 'turn-done',
        agentSessionID: toAgentSessionID('g1'),
        nameSource: '/home/u/.grok/sessions/%2Ftmp/g1/summary.json',
        detail: `${'x'.repeat(599)}…`,
        result: 'x'.repeat(700),
      },
    ],
    next: { lastKind: 'turn-done', latestPromptID: 'p2' },
  });
});

test.each([['channel_closed'], ['shutdown']])(
  'it reads a stop whose reason is %s as a heartbeat',
  (reason) => {
    expect(
      planGrokHookEvents(
        { atcId: toSessionID('s1'), event: 'Stop', payload: { sessionId: 'g1', reason } },
        undefined,
        '/home/u/.grok',
      ).events,
    ).toStrictEqual([{ kind: 'heartbeat', agentSessionID: toAgentSessionID('g1') }]);
  },
);

test.each([
  ['StopCancelled', { sessionId: 'g1', reason: 'user_interrupt' }],
  ['StopFailure', { sessionId: 'g1', error: 'rate_limit' }],
])('it reads a %s hook as a finished turn', (event, payload) => {
  expect(
    planGrokHookEvents({ atcId: toSessionID('s1'), event, payload }, undefined, '/home/u/.grok')
      .events,
  ).toStrictEqual([{ kind: 'turn-done', agentSessionID: toAgentSessionID('g1') }]);
});

test('it reads a cancelled stop for a prompt older than the latest submitted one as a heartbeat', () => {
  expect(
    planGrokHookEvents(
      {
        atcId: toSessionID('s1'),
        event: 'StopCancelled',
        payload: { sessionId: 'g1', reason: 'user_interrupt', promptId: 'p1' },
      },
      { lastKind: 'prompt-submitted', latestPromptID: 'p2' },
      '/home/u/.grok',
    ).events,
  ).toStrictEqual([{ kind: 'heartbeat', agentSessionID: toAgentSessionID('g1') }]);
});

test('it reads a permission prompt as needs-input and records it', () => {
  expect(
    planGrokHookEvents(
      {
        atcId: toSessionID('s1'),
        event: 'Notification',
        payload: { sessionId: 'g1', notificationType: 'permission_prompt', message: 'allow edit?' },
      },
      { lastKind: 'prompt-submitted', latestPromptID: 'p1' },
      '/home/u/.grok',
    ),
  ).toStrictEqual({
    events: [
      {
        kind: 'needs-input',
        agentSessionID: toAgentSessionID('g1'),
        message: 'allow edit?',
        detail: 'allow edit?',
      },
    ],
    next: { lastKind: 'needs-input', latestPromptID: 'p1' },
  });
});

test('it reads an idle notice right after a permission prompt as a heartbeat', () => {
  expect(
    planGrokHookEvents(
      {
        atcId: toSessionID('s1'),
        event: 'Notification',
        payload: { sessionId: 'g1', notificationType: 'idle_prompt' },
      },
      { lastKind: 'needs-input' },
      '/home/u/.grok',
    ),
  ).toStrictEqual({
    events: [{ kind: 'heartbeat', agentSessionID: toAgentSessionID('g1') }],
    next: { lastKind: 'needs-input' },
  });
});

test('it reads an idle notice after a submitted prompt as a finished turn', () => {
  expect(
    planGrokHookEvents(
      {
        atcId: toSessionID('s1'),
        event: 'Notification',
        payload: { sessionId: 'g1', cwd: '/tmp', notificationType: 'idle_prompt' },
      },
      { lastKind: 'prompt-submitted', latestPromptID: 'p1' },
      '/home/u/.grok',
    ),
  ).toStrictEqual({
    events: [
      {
        kind: 'turn-done',
        agentSessionID: toAgentSessionID('g1'),
        nameSource: '/home/u/.grok/sessions/%2Ftmp/g1/summary.json',
      },
    ],
    next: { lastKind: 'turn-done', latestPromptID: 'p1' },
  });
});

test('it reads a notice of another type as a heartbeat that keeps the state', () => {
  expect(
    planGrokHookEvents(
      {
        atcId: toSessionID('s1'),
        event: 'Notification',
        payload: { sessionId: 'g1', notificationType: 'auth_success' },
      },
      { lastKind: 'needs-input', latestPromptID: 'p1' },
      '/home/u/.grok',
    ),
  ).toStrictEqual({
    events: [{ kind: 'heartbeat', agentSessionID: toAgentSessionID('g1') }],
    next: { lastKind: 'needs-input', latestPromptID: 'p1' },
  });
});

test.each([
  ['Stop', { sessionId: 'g1', reason: 'end_turn', subagentType: 'explore' }],
  ['UserPromptSubmit', { sessionId: 'g1', promptId: 'p9', prompt: 'sub', subagentType: 'explore' }],
  ['SessionEnd', { sessionId: 'g1', subagentType: 'explore' }],
])('it reads a subagent %s line as a heartbeat that keeps the state', (event, payload) => {
  expect(
    planGrokHookEvents(
      { atcId: toSessionID('s1'), event, payload },
      { lastKind: 'prompt-submitted', latestPromptID: 'p1' },
      '/home/u/.grok',
    ),
  ).toStrictEqual({
    events: [{ kind: 'heartbeat', agentSessionID: toAgentSessionID('g1') }],
    next: { lastKind: 'prompt-submitted', latestPromptID: 'p1' },
  });
});

test('it ends a session and leaves no state', () => {
  expect(
    planGrokHookEvents(
      { atcId: toSessionID('s1'), event: 'SessionEnd', payload: { sessionId: 'g1' } },
      { lastKind: 'turn-done', latestPromptID: 'p1' },
      '/home/u/.grok',
    ),
  ).toStrictEqual({ events: [{ kind: 'ended', agentSessionID: toAgentSessionID('g1') }] });
});

test('it reads a hook event Grok does not register as a heartbeat', () => {
  expect(
    planGrokHookEvents(
      { atcId: toSessionID('s1'), event: 'PreToolUse', payload: { sessionId: 'g1' } },
      undefined,
      '/home/u/.grok',
    ),
  ).toStrictEqual({
    events: [{ kind: 'heartbeat', agentSessionID: toAgentSessionID('g1') }],
    next: { lastKind: 'heartbeat' },
  });
});

test('it reads a state it did not write as none', () => {
  expect(
    planGrokHookEvents(
      {
        atcId: toSessionID('s1'),
        event: 'Notification',
        payload: { sessionId: 'g1', notificationType: 'idle_prompt' },
      },
      { lastKind: 'waiting', latestPromptID: 4 },
      '/home/u/.grok',
    ).events,
  ).toStrictEqual([{ kind: 'turn-done', agentSessionID: toAgentSessionID('g1') }]);
});

test('it maps a non-object hook payload to a bare heartbeat instead of throwing', () => {
  expect(
    planGrokHookEvents(
      {
        atcId: toSessionID('s1'),
        event: 'Stop',
        payload: 'garbage',
      },
      undefined,
      '/home/u/.grok',
    ).events,
  ).toStrictEqual([{ kind: 'heartbeat' }]);
});

test('it treats wrong-typed hook payload fields as absent instead of throwing', () => {
  expect(
    planGrokHookEvents(
      {
        atcId: toSessionID('s1'),
        event: 'Stop',
        payload: { sessionId: 9, cwd: null, reason: ['end_turn'], promptId: 12 },
      },
      undefined,
      '/home/u/.grok',
    ).events,
  ).toStrictEqual([{ kind: 'heartbeat' }]);
});
