import { expect, test } from 'bun:test';
import type { RequiredKeysOf } from 'type-fest';
import type { AgentAdapter } from '../agents/agent-adapter';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toSessionID } from '../shared/to-session-id';
import { buildStubAgentAdapter } from './build-stub-agent-adapter';
import { startTestDaemon } from './start-test-daemon';
import { waitFor } from './wait-for';

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

  expect(Object.keys(buildStubAgentAdapter())).toIncludeSameMembers(Object.keys(required));
});

test('it builds a claude adapter with no runner, detector, or inbox', () => {
  const adapter = buildStubAgentAdapter();

  expect({
    id: adapter.id,
    headlessRunner: adapter.headlessRunner,
    screenDetector: adapter.screenDetector,
    takesMessages: adapter.takesMessages,
  }).toStrictEqual({
    id: 'claude',
    headlessRunner: null,
    screenDetector: null,
    takesMessages: false,
  });
});

test('it plans every spawn as a sleep that outlives the test', () => {
  expect(buildStubAgentAdapter().planSpawn({ prompt: 'hi', resume: true })).toStrictEqual({
    bin: 'sleep',
    args: ['30'],
  });
});

test('it reads every hook as a heartbeat', () => {
  expect(
    buildStubAgentAdapter().normalizeHook({
      atcId: toSessionID('s-1'),
      event: 'SessionStart',
      payload: { session_id: 'c-1' },
    }),
  ).toStrictEqual({ kind: 'heartbeat' });
});

test('it loads no name for a session', () => {
  expect(buildStubAgentAdapter().loadName('/tmp/transcript.jsonl', 'agent')).resolves.toBeNull();
});

test('it resumes any session without a resume command', () => {
  const adapter = buildStubAgentAdapter();

  expect([
    adapter.canResume({ agentSessionID: toAgentSessionID('c-1') }),
    adapter.buildResumeCommand('/tmp', toAgentSessionID('c-1')),
  ]).toStrictEqual([true, null]);
});

test('it replaces the members an override gives', () => {
  const adapter = buildStubAgentAdapter({ id: 'grok', takesMessages: true });

  expect([adapter.id, adapter.takesMessages]).toStrictEqual(['grok', true]);
});

test('it spawns a session the real daemon reports alive', async () => {
  await using harness = await startTestDaemon({
    options: () => ({ adapter: buildStubAgentAdapter() }),
  });

  await harness.client.sendRequest('session.spawn', { cwd: harness.dir, name: 'alpha' });

  const listed = await waitFor(async () => {
    const answer = await harness.client.sendRequest('session.list');

    expect(answer['sessions']).toPartiallyContain({ name: 'alpha', alive: true });

    return answer;
  });

  expect(listed['sessions']).toHaveLength(1);
});

test('it is listed as an agent that is not installed', async () => {
  await using harness = await startTestDaemon({
    options: () => ({ adapter: buildStubAgentAdapter() }),
  });

  const listed = await harness.client.sendRequest('agents.list');

  expect(listed['agents']).toPartiallyContain({ id: 'claude', installed: false });
});
