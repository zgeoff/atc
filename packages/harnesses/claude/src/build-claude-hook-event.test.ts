import { expect, test } from 'bun:test';
import { toAgentSessionID } from '@atc/core/to-agent-session-id';
import { toSessionID } from '@atc/core/to-session-id';
import { buildClaudeHookEvent } from './build-claude-hook-event';

test('it starts the session with the transcript as its name source and transcript', () => {
  expect(
    buildClaudeHookEvent({
      atcId: toSessionID('s1'),
      event: 'SessionStart',
      payload: { session_id: 'c-1', transcript_path: '/t/c-1.jsonl' },
    }),
  ).toStrictEqual({
    kind: 'started',
    agentSessionID: toAgentSessionID('c-1'),
    nameSource: '/t/c-1.jsonl',
    transcriptSource: '/t/c-1.jsonl',
  });
});

test('it maps a non-object hook payload to a bare event instead of throwing', () => {
  expect(
    buildClaudeHookEvent({
      atcId: toSessionID('s1'),
      event: 'Stop',

      // oxlint-disable-next-line no-unsafe-type-assertion -- exercising a non-object payload that the hook event's declared shape rules out but a hostile or buggy reporter could still send
      payload: 'garbage' as unknown as Record<string, unknown>,
    }),
  ).toStrictEqual({ kind: 'turn-done' });
});

test('it treats wrong-typed hook payload fields as absent instead of throwing', () => {
  expect(
    buildClaudeHookEvent({
      atcId: toSessionID('s1'),
      event: 'Stop',
      payload: { session_id: 42, transcript_path: null, last_assistant_message: ['pong'] },
    }),
  ).toStrictEqual({ kind: 'turn-done' });
});

test('it carries the whole last assistant message of a finished turn as its result', () => {
  expect(
    buildClaudeHookEvent({
      atcId: toSessionID('s1'),
      event: 'Stop',
      payload: { session_id: 'c-1', last_assistant_message: 'x'.repeat(700) },
    }),
  ).toStrictEqual({
    kind: 'turn-done',
    agentSessionID: toAgentSessionID('c-1'),
    detail: `${'x'.repeat(599)}…`,
    result: 'x'.repeat(700),
  });
});

test('it marks a permission prompt notification as pending a permission answer', () => {
  expect(
    buildClaudeHookEvent({
      atcId: toSessionID('s1'),
      event: 'Notification',
      payload: {
        session_id: 'c-1',
        message: 'Claude needs your permission to use Bash',
        notification_type: 'permission_prompt',
      },
    }),
  ).toStrictEqual({
    kind: 'needs-input',
    agentSessionID: toAgentSessionID('c-1'),
    permissionPending: true,
    message: 'Claude needs your permission to use Bash',
    detail: 'Claude needs your permission to use Bash',
  });
});

test('it marks an idle notification as closing any permission prompt', () => {
  expect(
    buildClaudeHookEvent({
      atcId: toSessionID('s1'),
      event: 'Notification',
      payload: {
        session_id: 'c-1',
        message: 'Claude is waiting for your input',
        notification_type: 'idle_prompt',
      },
    }),
  ).toStrictEqual({
    kind: 'needs-input',
    agentSessionID: toAgentSessionID('c-1'),
    permissionPending: false,
    message: 'Claude is waiting for your input',
    detail: 'Claude is waiting for your input',
  });
});

test('it leaves the permission field out of a notification of another type', () => {
  expect(
    buildClaudeHookEvent({
      atcId: toSessionID('s1'),
      event: 'Notification',
      payload: {
        session_id: 'c-1',
        message: 'Agent finished',
        notification_type: 'agent_completed',
      },
    }),
  ).toStrictEqual({
    kind: 'needs-input',
    agentSessionID: toAgentSessionID('c-1'),
    message: 'Agent finished',
    detail: 'Agent finished',
  });
});

test('it previews a submitted prompt with the transcript as its sources', () => {
  expect(
    buildClaudeHookEvent({
      atcId: toSessionID('s1'),
      event: 'UserPromptSubmit',
      payload: { session_id: 'c-1', transcript_path: '/t/c-1.jsonl', prompt: 'fix the build' },
    }),
  ).toStrictEqual({
    kind: 'prompt-submitted',
    agentSessionID: toAgentSessionID('c-1'),
    nameSource: '/t/c-1.jsonl',
    transcriptSource: '/t/c-1.jsonl',
    message: 'fix the build',
    detail: 'fix the build',
  });
});

test('it ends the session without its sources', () => {
  expect(
    buildClaudeHookEvent({
      atcId: toSessionID('s1'),
      event: 'SessionEnd',
      payload: { session_id: 'c-1', transcript_path: '/t/c-1.jsonl' },
    }),
  ).toStrictEqual({ kind: 'ended', agentSessionID: toAgentSessionID('c-1') });
});

test('it reads an event the settings file does not register as a heartbeat', () => {
  expect(
    buildClaudeHookEvent({
      atcId: toSessionID('s1'),
      event: 'PreToolUse',
      payload: { session_id: 'c-1' },
    }),
  ).toStrictEqual({ kind: 'heartbeat', agentSessionID: toAgentSessionID('c-1') });
});
