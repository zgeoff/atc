import { expect, test } from 'bun:test';
import { toAgentSessionID } from '@atc/core/to-agent-session-id';
import { toSessionID } from '@atc/core/to-session-id';
import { buildStubHarnessAdapter } from './build-stub-harness-adapter';

test('it builds an adapter with no optional members by default', () => {
  expect(buildStubHarnessAdapter()).toStrictEqual({
    id: 'claude',
    headlessRunner: null,
    screenDetector: null,
    takesMessages: false,
    spawns: [],
    hookReads: [],
    planSpawn: expect.toBeFunction(),
    planHookEvents: expect.toBeFunction(),
    loadName: expect.toBeFunction(),
    canResume: expect.toBeFunction(),
    buildResumeCommand: expect.toBeFunction(),
  });
});

test('it applies the id and message support the config gives', () => {
  const adapter = buildStubHarnessAdapter({ id: 'grok', takesMessages: true });

  expect(adapter.id).toBe('grok');
  expect(adapter.takesMessages).toBeTrue();
});

test('it plans every spawn as the stub harness and records it with its session', () => {
  const adapter = buildStubHarnessAdapter();
  const plan = adapter.planSpawn({ prompt: 'hi', resume: false }, toSessionID('s-1'));

  adapter.planSpawn({ prompt: '', resume: true });

  expect(plan).toStrictEqual({ bin: 'stub-harness', args: [] });

  expect(adapter.spawns).toStrictEqual([
    { opts: { prompt: 'hi', resume: false }, session: toSessionID('s-1') },
    { opts: { prompt: '', resume: true } },
  ]);
});

test('it reads a hook as the events the config table holds for its name', () => {
  const adapter = buildStubHarnessAdapter({
    hooks: { Notification: [{ kind: 'needs-input', permissionPending: true }] },
  });

  expect(
    adapter.planHookEvents(
      { atcId: toSessionID('s-1'), event: 'Notification', payload: {} },
      undefined,
    ).events,
  ).toStrictEqual([{ kind: 'needs-input', permissionPending: true }]);
});

test('it reads a hook the config table lacks as one heartbeat', () => {
  expect(
    buildStubHarnessAdapter().planHookEvents(
      { atcId: toSessionID('s-1'), event: 'Stop', payload: {} },
      undefined,
    ).events,
  ).toStrictEqual([{ kind: 'heartbeat' }]);
});

test('it counts the lines a session reported in the state it returns', () => {
  const adapter = buildStubHarnessAdapter();

  const first = adapter.planHookEvents(
    { atcId: toSessionID('s-1'), event: 'Stop', payload: {} },
    undefined,
  );

  const second = adapter.planHookEvents(
    { atcId: toSessionID('s-1'), event: 'Stop', payload: {} },
    first.next,
  );

  expect(first.next).toBe(1);
  expect(second.next).toBe(2);
});

test('it records each hook line with the state passed back for it', () => {
  const adapter = buildStubHarnessAdapter();

  adapter.planHookEvents({ atcId: toSessionID('s-1'), event: 'Stop', payload: {} }, 4);

  expect(adapter.hookReads).toStrictEqual([
    { hook: { atcId: toSessionID('s-1'), event: 'Stop', payload: {} }, prev: 4 },
  ]);
});

test('it loads no name for a session', () => {
  expect(buildStubHarnessAdapter().loadName('/nonexistent', 'agent')).resolves.toBeNull();
});

test('it resumes any session and gives no resume command', () => {
  const adapter = buildStubHarnessAdapter();

  expect(adapter.canResume({ agentSessionID: toAgentSessionID('c-1') })).toBeTrue();
  expect(adapter.buildResumeCommand('/work', toAgentSessionID('c-1'))).toBeNull();
});
