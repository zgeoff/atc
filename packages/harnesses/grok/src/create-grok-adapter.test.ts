import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig } from '@atc/config';
import { toAgentSessionID, toSessionID } from '@atc/core';
import { getAgentEntry, setupTempDir } from '@atc/test-utils';
import { createGrokAdapter } from './create-grok-adapter';
import { GROK_PLUGIN } from './grok-plugin';

// A Grok home of the test's own, where the adapter looks for session summaries.
function setupTest() {
  const temporaryDirectory = setupTempDir('atc-grok-home-');

  return { directory: temporaryDirectory.path };
}

test('it plans a new spawn without resume or -p and appends --no-leader', () => {
  const plan = createGrokAdapter(getAgentEntry(parseConfig([GROK_PLUGIN], {}), 'grok')).planSpawn({
    prompt: 'fix the bug',
    resume: false,
  });

  expect(plan).toStrictEqual({
    bin: 'grok',
    args: ['--no-leader', 'fix the bug'],
  });
});

test('it plans adopt without --resume', () => {
  const plan = createGrokAdapter(getAgentEntry(parseConfig([GROK_PLUGIN], {}), 'grok')).planSpawn({
    prompt: '',
    resume: true,
  });

  expect(plan.args).toStrictEqual(['--no-leader']);
});

test('it plans restore with --resume after --no-leader', () => {
  const plan = createGrokAdapter(getAgentEntry(parseConfig([GROK_PLUGIN], {}), 'grok')).planSpawn({
    prompt: '',
    resume: toAgentSessionID('01a0148d-f30c-7091-9bbf-548c4a7ed49e'),
  });

  expect(plan.args).toStrictEqual([
    '--no-leader',
    '--resume',
    '01a0148d-f30c-7091-9bbf-548c4a7ed49e',
  ]);
});

test('it drops a user --leader from the configured arguments and still appends --no-leader', () => {
  const config = parseConfig([GROK_PLUGIN], {
    agents: { grok: { args: ['--leader', '--yolo'] } },
  });

  const plan = createGrokAdapter(getAgentEntry(config, 'grok')).planSpawn({
    prompt: '',
    resume: false,
  });

  expect(plan.args).toStrictEqual(['--yolo', '--no-leader']);
});

test('it yanks a captured id as grok --resume', () => {
  const adapter = createGrokAdapter(getAgentEntry(parseConfig([GROK_PLUGIN], {}), 'grok'));

  expect(adapter.planResumeCommand("/tmp/o'reilly", toAgentSessionID('sess-9'))).toBe(
    String.raw`cd '/tmp/o'\''reilly' && grok --resume sess-9`,
  );
});

test('it yanks an uncaptured session as plain grok', () => {
  const adapter = createGrokAdapter(getAgentEntry(parseConfig([GROK_PLUGIN], {}), 'grok'));

  expect(adapter.planResumeCommand('/tmp/proj', undefined)).toBe("cd '/tmp/proj' && grok");
});

test('it plans hook events from the state the previous line left, naming sessions in its own home', () => {
  const ctx = setupTest();

  const adapter = createGrokAdapter(
    getAgentEntry(parseConfig([GROK_PLUGIN], {}), 'grok'),
    ctx.directory,
  );

  const plan = adapter.planHookEvents(
    {
      atcId: toSessionID('s1'),
      event: 'Notification',
      payload: { sessionId: 'g1', cwd: '/tmp', notificationType: 'idle_prompt' },
    },
    { lastKind: 'prompt-submitted', latestPromptID: 'p1' },
  );

  expect(plan).toStrictEqual({
    events: [
      {
        kind: 'turn-done',
        agentSessionID: toAgentSessionID('g1'),
        nameSource: join(ctx.directory, 'sessions', '%2Ftmp', 'g1', 'summary.json'),
      },
    ],
    next: { lastKind: 'turn-done', latestPromptID: 'p1' },
  });
});

test('it loads a name from the summary of a session in its own home', async () => {
  const ctx = setupTest();
  const file = join(ctx.directory, 'summary.json');

  writeFileSync(file, JSON.stringify({ generated_title: 'auto title' }));

  const update = await createGrokAdapter(
    getAgentEntry(parseConfig([GROK_PLUGIN], {}), 'grok'),
    ctx.directory,
  ).loadName(file, 'auto');

  expect(update).toStrictEqual({ name: 'auto title' });
});

test('it resumes when a session id was captured', () => {
  const adapter = createGrokAdapter(getAgentEntry(parseConfig([GROK_PLUGIN], {}), 'grok'));

  expect(adapter.canResume({ agentSessionID: toAgentSessionID('g1') })).toBeTrue();
});

test('it resumes a captured session whose summary path is missing', () => {
  const adapter = createGrokAdapter(getAgentEntry(parseConfig([GROK_PLUGIN], {}), 'grok'));

  expect(
    adapter.canResume({
      agentSessionID: toAgentSessionID('g1'),
      transcriptSource: '/missing/summary.json',
    }),
  ).toBeTrue();
});

test('it does not resume a session with no captured id', () => {
  const adapter = createGrokAdapter(getAgentEntry(parseConfig([GROK_PLUGIN], {}), 'grok'));

  expect(adapter.canResume({})).toBeFalse();
});

test('it refuses inbox messages', () => {
  const adapter = createGrokAdapter(getAgentEntry(parseConfig([GROK_PLUGIN], {}), 'grok'));

  expect(adapter.takesMessages).toBeFalse();
});

test('it takes neither a model nor an effort from a spawn', () => {
  const adapter = createGrokAdapter(getAgentEntry(parseConfig([GROK_PLUGIN], {}), 'grok'));

  expect(adapter.profile.spawnOptions).toStrictEqual({
    model: {
      supported: false,
      values: null,
      examples: [],
      default: null,
      backendEffect: null,
      note: 'atc does not pass this option to Grok.',
    },
    effort: {
      supported: false,
      values: null,
      examples: [],
      default: null,
      backendEffect: null,
      note: 'atc does not pass this option to Grok.',
    },
  });
});
