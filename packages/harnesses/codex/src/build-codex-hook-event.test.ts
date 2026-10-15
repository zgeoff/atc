import { expect, test } from 'bun:test';
import { toAgentSessionID, toSessionID } from '@atc/core';
import { buildCodexHookEvent } from './build-codex-hook-event';

test('it starts the session with its id as the name source and its rollout as the transcript', () => {
  expect(
    buildCodexHookEvent({
      atcId: toSessionID('s1'),
      event: 'SessionStart',
      payload: {
        session_id: 'c-1',
        transcript_path: '/tmp/rollout-c-1.jsonl',
        cwd: '/tmp',
        hook_event_name: 'SessionStart',
        source: 'startup',
      },
    }),
  ).toStrictEqual({
    kind: 'started',
    agentSessionID: toAgentSessionID('c-1'),
    nameSource: 'c-1',
    transcriptSource: '/tmp/rollout-c-1.jsonl',
  });
});

test('it reads a prompt submit as a submitted prompt', () => {
  expect(
    buildCodexHookEvent({
      atcId: toSessionID('s1'),
      event: 'UserPromptSubmit',
      payload: { session_id: 'c-1', prompt: 'do the thing' },
    }),
  ).toStrictEqual({
    kind: 'prompt-submitted',
    agentSessionID: toAgentSessionID('c-1'),
    nameSource: 'c-1',
    message: 'do the thing',
    detail: 'do the thing',
  });
});

test('it reads a stop as a finished turn', () => {
  expect(
    buildCodexHookEvent({
      atcId: toSessionID('s1'),
      event: 'Stop',
      payload: { session_id: 'c-1', last_assistant_message: 'pong' },
    }),
  ).toStrictEqual({
    kind: 'turn-done',
    agentSessionID: toAgentSessionID('c-1'),
    nameSource: 'c-1',
    detail: 'pong',
    result: 'pong',
  });
});

test('it carries the whole last assistant message of a finished turn as its result', () => {
  expect(
    buildCodexHookEvent({
      atcId: toSessionID('s1'),
      event: 'Stop',
      payload: { session_id: 'c-1', last_assistant_message: 'x'.repeat(700) },
    }),
  ).toStrictEqual({
    kind: 'turn-done',
    agentSessionID: toAgentSessionID('c-1'),
    nameSource: 'c-1',
    detail: `${'x'.repeat(599)}…`,
    result: 'x'.repeat(700),
  });
});

test('it reads a permission request as needs-input naming the tool', () => {
  expect(
    buildCodexHookEvent({
      atcId: toSessionID('s1'),
      event: 'PermissionRequest',
      payload: { session_id: 'c-1', tool_name: 'shell' },
    }),
  ).toStrictEqual({
    kind: 'needs-input',
    agentSessionID: toAgentSessionID('c-1'),
    message: 'waiting for approval: shell',
    detail: 'waiting for approval: shell',
  });
});

test('it reads a session end as ended', () => {
  expect(
    buildCodexHookEvent({
      atcId: toSessionID('s1'),
      event: 'SessionEnd',
      payload: { session_id: 'c-1', reason: 'other' },
    }),
  ).toStrictEqual({ kind: 'ended', agentSessionID: toAgentSessionID('c-1') });
});

test('it reads a hook event Codex does not register as a heartbeat', () => {
  expect(
    buildCodexHookEvent({
      atcId: toSessionID('s1'),
      event: 'Notification',
      payload: { session_id: 'c-1', message: 'idle' },
    }),
  ).toStrictEqual({ kind: 'heartbeat', agentSessionID: toAgentSessionID('c-1') });
});

test('it maps a non-object hook payload to a bare event instead of throwing', () => {
  expect(
    buildCodexHookEvent({
      atcId: toSessionID('s1'),
      event: 'Stop',

      // oxlint-disable-next-line no-unsafe-type-assertion -- exercising a non-object payload that the hook event's declared shape rules out but a hostile or buggy reporter could still send
      payload: 'garbage' as unknown as Record<string, unknown>,
    }),
  ).toStrictEqual({ kind: 'turn-done' });
});

test('it treats wrong-typed hook payload fields as absent instead of throwing', () => {
  expect(
    buildCodexHookEvent({
      atcId: toSessionID('s1'),
      event: 'PermissionRequest',
      payload: { session_id: null, tool_name: 7 },
    }),
  ).toStrictEqual({
    kind: 'needs-input',
    message: 'waiting for approval',
    detail: 'waiting for approval',
  });
});
