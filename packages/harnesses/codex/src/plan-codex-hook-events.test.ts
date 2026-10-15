import { expect, test } from 'bun:test';
import { toAgentSessionID, toSessionID } from '@atc/core';
import { planCodexHookEvents } from './plan-codex-hook-events';

test('it starts a session on the reported thread and records the thread', () => {
  expect(
    planCodexHookEvents(
      {
        atcId: toSessionID('s1'),
        event: 'SessionStart',
        payload: { session_id: 'thread-b', transcript_path: '/rollouts/b.jsonl' },
      },
      { thread: 'thread-a' },
    ),
  ).toStrictEqual({
    events: [
      {
        kind: 'started',
        agentSessionID: toAgentSessionID('thread-b'),
        nameSource: 'thread-b',
        transcriptSource: '/rollouts/b.jsonl',
      },
    ],
    next: { thread: 'thread-b' },
  });
});

test('it reads a finished turn of the recorded thread as it reads', () => {
  expect(
    planCodexHookEvents(
      {
        atcId: toSessionID('s1'),
        event: 'Stop',
        payload: { session_id: 'thread-a', last_assistant_message: 'tests pass' },
      },
      { thread: 'thread-a' },
    ),
  ).toStrictEqual({
    events: [
      {
        kind: 'turn-done',
        agentSessionID: toAgentSessionID('thread-a'),
        nameSource: 'thread-a',
        detail: 'tests pass',
        result: 'tests pass',
      },
    ],
    next: { thread: 'thread-a' },
  });
});

test('it reads a finished turn of another thread as a heartbeat without a thread', () => {
  expect(
    planCodexHookEvents(
      {
        atcId: toSessionID('s1'),
        event: 'Stop',
        payload: { session_id: 'thread-a', last_assistant_message: 'tests pass' },
      },
      { thread: 'thread-b' },
    ),
  ).toStrictEqual({ events: [{ kind: 'heartbeat' }], next: { thread: 'thread-b' } });
});

test('it reads a submitted prompt of another thread as a heartbeat without a thread', () => {
  expect(
    planCodexHookEvents(
      {
        atcId: toSessionID('s1'),
        event: 'UserPromptSubmit',
        payload: { session_id: 'thread-a', prompt: 'add a test' },
      },
      { thread: 'thread-b' },
    ),
  ).toStrictEqual({ events: [{ kind: 'heartbeat' }], next: { thread: 'thread-b' } });
});

test('it reads a permission request of another thread as needs-input without a thread', () => {
  expect(
    planCodexHookEvents(
      {
        atcId: toSessionID('s1'),
        event: 'PermissionRequest',
        payload: { session_id: 'thread-a', tool_name: 'shell' },
      },
      { thread: 'thread-b' },
    ),
  ).toStrictEqual({
    events: [
      {
        kind: 'needs-input',
        message: 'waiting for approval: shell',
        detail: 'waiting for approval: shell',
      },
    ],
    next: { thread: 'thread-b' },
  });
});

test('it reads a session end of another thread as a heartbeat without a thread', () => {
  expect(
    planCodexHookEvents(
      { atcId: toSessionID('s1'), event: 'SessionEnd', payload: { session_id: 'thread-a' } },
      { thread: 'thread-b' },
    ),
  ).toStrictEqual({ events: [{ kind: 'heartbeat' }], next: { thread: 'thread-b' } });
});

test('it reads a line before any session start as it reads and records no thread', () => {
  expect(
    planCodexHookEvents(
      {
        atcId: toSessionID('s1'),
        event: 'UserPromptSubmit',
        payload: { session_id: 'thread-a', prompt: 'add a test' },
      },
      undefined,
    ),
  ).toStrictEqual({
    events: [
      {
        kind: 'prompt-submitted',
        agentSessionID: toAgentSessionID('thread-a'),
        nameSource: 'thread-a',
        message: 'add a test',
        detail: 'add a test',
      },
    ],
  });
});
