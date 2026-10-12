import { expect, test } from 'bun:test';
import type { RequiredKeysOf } from 'type-fest';
import type { AgentAdapter } from '../agents/agent-adapter';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toSessionID } from '../shared/to-session-id';
import { buildMockAgentAdapter } from './build-mock-agent-adapter';

test('it builds a default agent adapter', () => {
  expect(buildMockAgentAdapter()).toStrictEqual({
    id: 'claude',
    headlessRunner: null,
    screenDetector: null,
    takesMessages: false,
    planSpawn: expect.toBeFunction(),
    normalizeHook: expect.toBeFunction(),
    loadName: expect.toBeFunction(),
    canResume: expect.toBeFunction(),
    buildResumeCommand: expect.toBeFunction(),
  });
});

test('it applies overrides on top of the defaults', () => {
  expect(buildMockAgentAdapter({ id: 'grok', takesMessages: true })).toStrictEqual({
    id: 'grok',
    headlessRunner: null,
    screenDetector: null,
    takesMessages: true,
    planSpawn: expect.toBeFunction(),
    normalizeHook: expect.toBeFunction(),
    loadName: expect.toBeFunction(),
    canResume: expect.toBeFunction(),
    buildResumeCommand: expect.toBeFunction(),
  });
});

test('it sets exactly the members the adapter interface requires', () => {
  const required: Record<RequiredKeysOf<AgentAdapter>, true> = {
    id: true,
    headlessRunner: true,
    screenDetector: true,
    takesMessages: true,
    planSpawn: true,
    normalizeHook: true,
    loadName: true,
    canResume: true,
    buildResumeCommand: true,
  };

  expect(Object.keys(buildMockAgentAdapter())).toIncludeSameMembers(Object.keys(required));
});

test('it plans every spawn as a sleep that outlives the test', () => {
  expect(buildMockAgentAdapter().planSpawn({ prompt: 'hi', resume: true })).toStrictEqual({
    bin: 'sleep',
    args: ['30'],
  });
});

test('it reads every hook as a heartbeat', () => {
  expect(
    buildMockAgentAdapter().normalizeHook({
      atcId: toSessionID('s-1'),
      event: 'SessionStart',
      payload: { session_id: 'c-1' },
    }),
  ).toStrictEqual({ kind: 'heartbeat' });
});

test('it loads no name for a session', () => {
  expect(
    buildMockAgentAdapter().loadName('/nonexistent/transcript.jsonl', 'agent'),
  ).resolves.toBeNull();
});

test('it resumes any session', () => {
  expect(buildMockAgentAdapter().canResume({ agentSessionID: toAgentSessionID('c-1') })).toBeTrue();
});

test('it gives no resume command', () => {
  expect(
    buildMockAgentAdapter().buildResumeCommand('/nonexistent', toAgentSessionID('c-1')),
  ).toBeNull();
});
