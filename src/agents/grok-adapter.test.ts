import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig } from '../shared/config';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toSessionID } from '../shared/to-session-id';
import { getAgentEntry } from '../test-utils/get-agent-entry';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { GrokAdapter } from './grok-adapter';

// A Grok home of the test's own, where the adapter looks for session summaries.
function setupTest() {
  const tmp = setupTempDir('atc-grok-home-');

  return { dir: tmp.dir };
}

test('it plans a new spawn without resume or -p and appends --no-leader', () => {
  const plan = new GrokAdapter(getAgentEntry(parseConfig({}), 'grok')).planSpawn({
    prompt: 'fix the bug',
    resume: false,
  });

  expect(plan).toStrictEqual({
    bin: 'grok',
    args: ['--no-leader', 'fix the bug'],
  });
});

test('it plans adopt without --resume', () => {
  const plan = new GrokAdapter(getAgentEntry(parseConfig({}), 'grok')).planSpawn({
    prompt: '',
    resume: true,
  });

  expect(plan.args).toStrictEqual(['--no-leader']);
});

test('it plans restore with --resume after --no-leader', () => {
  const plan = new GrokAdapter(getAgentEntry(parseConfig({}), 'grok')).planSpawn({
    prompt: '',
    resume: toAgentSessionID('01a0148d-f30c-7091-9bbf-548c4a7ed49e'),
  });

  expect(plan.args).toStrictEqual([
    '--no-leader',
    '--resume',
    '01a0148d-f30c-7091-9bbf-548c4a7ed49e',
  ]);
});

test('it drops a user --leader from grokArgs and still appends --no-leader', () => {
  const config = parseConfig({
    grokArgs: ['--leader', '--yolo'],
  });

  const plan = new GrokAdapter(getAgentEntry(config, 'grok')).planSpawn({
    prompt: '',
    resume: false,
  });

  expect(plan.args).toStrictEqual(['--yolo', '--no-leader']);
});

test('it yanks a captured id as grok --resume', () => {
  const adapter = new GrokAdapter(getAgentEntry(parseConfig({}), 'grok'));

  expect(adapter.buildResumeCommand("/tmp/o'reilly", toAgentSessionID('sess-9'))).toBe(
    String.raw`cd '/tmp/o'\''reilly' && grok --resume sess-9`,
  );
});

test('it yanks an uncaptured session as plain grok', () => {
  const adapter = new GrokAdapter(getAgentEntry(parseConfig({}), 'grok'));

  expect(adapter.buildResumeCommand('/tmp/proj', undefined)).toBe("cd '/tmp/proj' && grok");
});

test('it maps permission_prompt to needs-input', () => {
  const ev = new GrokAdapter(getAgentEntry(parseConfig({}), 'grok')).normalizeHook({
    atcId: toSessionID('s1'),
    event: 'Notification',
    payload: { sessionId: 'g1', notificationType: 'permission_prompt', message: 'allow edit?' },
  });

  expect(ev).toStrictEqual({
    kind: 'needs-input',
    agentSessionID: toAgentSessionID('g1'),
    message: 'allow edit?',
    detail: 'allow edit?',
  });
});

test.each([
  ['Stop', { sessionId: 'g1', cwd: '/tmp', reason: 'end_turn' }],
  ['StopCancelled', { sessionId: 'g1', reason: 'user_interrupt' }],
  ['StopFailure', { sessionId: 'g1', error: 'rate_limit' }],
])('it maps a %s hook with payload %p to turn-done', (event, payload) => {
  const adapter = new GrokAdapter(getAgentEntry(parseConfig({}), 'grok'));

  expect(adapter.normalizeHook({ atcId: toSessionID('s1'), event, payload }).kind).toBe(
    'turn-done',
  );
});

test.each([
  [{ sessionId: 'g1', reason: 'channel_closed' }],
  [{ sessionId: 'g1', reason: 'shutdown' }],
  [{ sessionId: 'g1', reason: 'end_turn', subagentType: 'explore' }],
])('it reads a Stop hook with payload %p as a heartbeat', (payload) => {
  const adapter = new GrokAdapter(getAgentEntry(parseConfig({}), 'grok'));

  expect(adapter.normalizeHook({ atcId: toSessionID('s1'), event: 'Stop', payload }).kind).toBe(
    'heartbeat',
  );
});

test('it evicts the oldest session once hook state passes 256 entries', () => {
  const adapter = new GrokAdapter(getAgentEntry(parseConfig({}), 'grok'));

  adapter.normalizeHook({
    atcId: toSessionID('s-0'),
    event: 'UserPromptSubmit',
    payload: { sessionId: 's-0', promptId: 'p2', prompt: 'first' },
  });

  for (let i = 1; i <= 255; i++) {
    adapter.normalizeHook({
      atcId: toSessionID(`s-${i}`),
      event: 'SessionStart',
      payload: { sessionId: `s-${i}`, cwd: '/tmp' },
    });
  }

  adapter.normalizeHook({
    atcId: toSessionID('s-256'),
    event: 'UserPromptSubmit',
    payload: { sessionId: 's-256', promptId: 'p2', prompt: 'last' },
  });

  const ev = adapter.normalizeHook({
    atcId: toSessionID('s-0'),
    event: 'Stop',
    payload: { sessionId: 's-0', reason: 'end_turn', promptId: 'p1' },
  });

  expect(ev.kind).toBe('turn-done');
});

test('it retains the newest session once hook state passes 256 entries', () => {
  const adapter = new GrokAdapter(getAgentEntry(parseConfig({}), 'grok'));

  for (let i = 0; i <= 255; i++) {
    adapter.normalizeHook({
      atcId: toSessionID(`s-${i}`),
      event: 'SessionStart',
      payload: { sessionId: `s-${i}`, cwd: '/tmp' },
    });
  }

  adapter.normalizeHook({
    atcId: toSessionID('s-256'),
    event: 'UserPromptSubmit',
    payload: { sessionId: 's-256', promptId: 'p2', prompt: 'last' },
  });

  const ev = adapter.normalizeHook({
    atcId: toSessionID('s-256'),
    event: 'Stop',
    payload: { sessionId: 's-256', reason: 'end_turn', promptId: 'p1' },
  });

  expect(ev.kind).toBe('heartbeat');
});

test('it ignores a stale promptId after a later submit', () => {
  const adapter = new GrokAdapter(getAgentEntry(parseConfig({}), 'grok'));

  adapter.normalizeHook({
    atcId: toSessionID('s1'),
    event: 'UserPromptSubmit',
    payload: { sessionId: 'g1', promptId: 'p2', prompt: 'next' },
  });

  const ev = adapter.normalizeHook({
    atcId: toSessionID('s1'),
    event: 'Stop',
    payload: { sessionId: 'g1', reason: 'end_turn', promptId: 'p1' },
  });

  expect(ev.kind).toBe('heartbeat');
});

test('it treats idle_prompt after needs-input as a heartbeat', () => {
  const adapter = new GrokAdapter(getAgentEntry(parseConfig({}), 'grok'));

  adapter.normalizeHook({
    atcId: toSessionID('s1'),
    event: 'Notification',
    payload: { sessionId: 'g1', notificationType: 'permission_prompt' },
  });

  const ev = adapter.normalizeHook({
    atcId: toSessionID('s1'),
    event: 'Notification',
    payload: { sessionId: 'g1', notificationType: 'idle_prompt' },
  });

  expect(ev.kind).toBe('heartbeat');
});

test('it treats idle_prompt after a submitted prompt as turn-done', () => {
  const adapter = new GrokAdapter(getAgentEntry(parseConfig({}), 'grok'));

  adapter.normalizeHook({
    atcId: toSessionID('s1'),
    event: 'UserPromptSubmit',
    payload: { sessionId: 'g1', promptId: 'p1', prompt: 'go' },
  });

  const ev = adapter.normalizeHook({
    atcId: toSessionID('s1'),
    event: 'Notification',
    payload: { sessionId: 'g1', cwd: '/tmp', notificationType: 'idle_prompt' },
  });

  expect(ev.kind).toBe('turn-done');
});

test('it captures SessionStart without a transcript path', () => {
  const ctx = setupTest();

  const ev = new GrokAdapter(getAgentEntry(parseConfig({}), 'grok'), ctx.dir).normalizeHook({
    atcId: toSessionID('s1'),
    event: 'SessionStart',
    payload: { sessionId: 'g1', cwd: '/tmp/proj' },
  });

  expect(ev).toStrictEqual({
    kind: 'started',
    agentSessionID: toAgentSessionID('g1'),
    nameSource: join(ctx.dir, 'sessions', encodeURIComponent('/tmp/proj'), 'g1', 'summary.json'),
  });
});

test('it loads a manual title over a user-typed name', async () => {
  const ctx = setupTest();
  const file = join(ctx.dir, 'summary.json');

  writeFileSync(
    file,
    JSON.stringify({
      title_is_manual: true,
      generated_title: 'renamed in grok',
      session_summary: 'auto blurb',
    }),
  );

  const update = await new GrokAdapter(getAgentEntry(parseConfig({}), 'grok')).loadName(
    file,
    'user',
  );

  expect(update).toStrictEqual({ name: 'renamed in grok', namedBy: 'agent' });
});

test('it loads an auto title when the session was not user-named', async () => {
  const ctx = setupTest();
  const file = join(ctx.dir, 'summary.json');

  writeFileSync(
    file,
    JSON.stringify({ generated_title: 'auto title', session_summary: 'auto blurb' }),
  );

  const update = await new GrokAdapter(getAgentEntry(parseConfig({}), 'grok')).loadName(
    file,
    'auto',
  );

  expect(update).toStrictEqual({ name: 'auto title' });
});

test('it keeps a user-typed name over an auto title', async () => {
  const ctx = setupTest();
  const file = join(ctx.dir, 'summary.json');

  writeFileSync(
    file,
    JSON.stringify({ generated_title: 'auto title', session_summary: 'auto blurb' }),
  );

  const update = await new GrokAdapter(getAgentEntry(parseConfig({}), 'grok')).loadName(
    file,
    'user',
  );

  expect(update).toBeNull();
});

test('it maps a non-object hook payload to a bare heartbeat instead of throwing', () => {
  const adapter = new GrokAdapter(getAgentEntry(parseConfig({}), 'grok'));

  const ev = adapter.normalizeHook({
    atcId: toSessionID('s1'),
    event: 'Stop',

    // oxlint-disable-next-line no-unsafe-type-assertion -- exercising a payload shape the HookEvent type rules out but a hostile or buggy reporter could still send
    payload: 'garbage' as unknown as Record<string, unknown>,
  });

  expect(ev).toStrictEqual({ kind: 'heartbeat' });
});

test('it treats wrong-typed hook payload fields as absent instead of throwing', () => {
  const adapter = new GrokAdapter(getAgentEntry(parseConfig({}), 'grok'));

  const ev = adapter.normalizeHook({
    atcId: toSessionID('s1'),
    event: 'Stop',
    payload: { sessionId: 9, cwd: null, reason: ['end_turn'], promptId: 12 },
  });

  expect(ev).toStrictEqual({ kind: 'heartbeat' });
});

test('it resumes when a session id was captured', () => {
  const adapter = new GrokAdapter(getAgentEntry(parseConfig({}), 'grok'));

  expect(adapter.canResume({ agentSessionID: toAgentSessionID('g1') })).toBeTrue();
});

test('it resumes a captured session whose summary path is missing', () => {
  const adapter = new GrokAdapter(getAgentEntry(parseConfig({}), 'grok'));

  expect(
    adapter.canResume({
      agentSessionID: toAgentSessionID('g1'),
      transcriptSource: '/missing/summary.json',
    }),
  ).toBeTrue();
});

test('it does not resume a session with no captured id', () => {
  const adapter = new GrokAdapter(getAgentEntry(parseConfig({}), 'grok'));

  expect(adapter.canResume({})).toBeFalse();
});

test('it carries the whole last assistant message of a finished turn as its result', () => {
  const ctx = setupTest();

  const adapter = new GrokAdapter(getAgentEntry(parseConfig({}), 'grok'), ctx.dir);

  const ev = adapter.normalizeHook({
    atcId: toSessionID('s1'),
    event: 'Stop',
    payload: {
      sessionId: 'g1',
      cwd: '/tmp',
      reason: 'end_turn',
      lastAssistantMessage: 'x'.repeat(700),
    },
  });

  expect(ev).toStrictEqual({
    kind: 'turn-done',
    agentSessionID: toAgentSessionID('g1'),
    nameSource: join(ctx.dir, 'sessions', encodeURIComponent('/tmp'), 'g1', 'summary.json'),
    detail: `${'x'.repeat(599)}…`,
    result: 'x'.repeat(700),
  });
});

test('it refuses inbox messages', () => {
  const adapter = new GrokAdapter(getAgentEntry(parseConfig({}), 'grok'));

  expect(adapter.takesMessages).toBeFalse();
});
