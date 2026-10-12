import { expect, test } from 'bun:test';
import { toAgentSessionID } from '@atc/core/to-agent-session-id';
import { toSessionID } from '@atc/core/to-session-id';
import { z } from 'zod';
import { buildClaudeStyleHookEvent } from './build-claude-style-hook-event';

test('it starts the session with its name and transcript sources', () => {
  const event = buildClaudeStyleHookEvent(
    { atcId: toSessionID('s1'), event: 'Begin', payload: { session_id: 'c-1' } },
    {
      hooks: { Begin: 'SessionStart' },
      parsePayload: (payload) => z.object({ session_id: z.string() }).parse(payload),
      buildNeedsInput: (base) => ({ ...base, kind: 'needs-input' }),
      buildSources: () => ({ nameSource: '/name', transcriptSource: '/transcript' }),
    },
  );

  expect(event).toStrictEqual({
    kind: 'started',
    agentSessionID: toAgentSessionID('c-1'),
    nameSource: '/name',
    transcriptSource: '/transcript',
  });
});

test("it builds a needs-input event by the harness's own rule, without the sources", () => {
  const event = buildClaudeStyleHookEvent(
    { atcId: toSessionID('s1'), event: 'Ask', payload: { session_id: 'c-1' } },
    {
      hooks: { Ask: 'NeedsInput' },
      parsePayload: (payload) => z.object({ session_id: z.string() }).parse(payload),
      buildNeedsInput: (base) => ({ ...base, kind: 'needs-input', message: 'waiting' }),
      buildSources: () => ({ nameSource: '/name' }),
    },
  );

  expect(event).toStrictEqual({
    kind: 'needs-input',
    agentSessionID: toAgentSessionID('c-1'),
    message: 'waiting',
  });
});

test("it finishes a turn with the turn's last message and the sources", () => {
  const event = buildClaudeStyleHookEvent(
    { atcId: toSessionID('s1'), event: 'Stop', payload: { last_assistant_message: 'done' } },
    {
      hooks: { Stop: 'Stop' },
      parsePayload: (payload) => z.object({ last_assistant_message: z.string() }).parse(payload),
      buildNeedsInput: (base) => ({ ...base, kind: 'needs-input' }),
      buildSources: () => ({ nameSource: '/name' }),
    },
  );

  expect(event).toStrictEqual({
    kind: 'turn-done',
    nameSource: '/name',
    detail: 'done',
    result: 'done',
  });
});

test('it previews a submitted prompt with the sources', () => {
  const event = buildClaudeStyleHookEvent(
    { atcId: toSessionID('s1'), event: 'UserPromptSubmit', payload: { prompt: 'go' } },
    {
      hooks: { UserPromptSubmit: 'UserPromptSubmit' },
      parsePayload: (payload) => z.object({ prompt: z.string() }).parse(payload),
      buildNeedsInput: (base) => ({ ...base, kind: 'needs-input' }),
      buildSources: () => ({ nameSource: '/name' }),
    },
  );

  expect(event).toStrictEqual({
    kind: 'prompt-submitted',
    nameSource: '/name',
    message: 'go',
    detail: 'go',
  });
});

test('it ends the session without the sources', () => {
  const event = buildClaudeStyleHookEvent(
    { atcId: toSessionID('s1'), event: 'SessionEnd', payload: { session_id: 'c-1' } },
    {
      hooks: { SessionEnd: 'SessionEnd' },
      parsePayload: (payload) => z.object({ session_id: z.string() }).parse(payload),
      buildNeedsInput: (base) => ({ ...base, kind: 'needs-input' }),
      buildSources: () => ({ nameSource: '/name' }),
    },
  );

  expect(event).toStrictEqual({ kind: 'ended', agentSessionID: toAgentSessionID('c-1') });
});

test('it reads an event the harness does not register as a heartbeat', () => {
  const event = buildClaudeStyleHookEvent(
    { atcId: toSessionID('s1'), event: 'PreToolUse', payload: { session_id: 'c-1' } },
    {
      hooks: { Stop: 'Stop' },
      parsePayload: (payload) => z.object({ session_id: z.string() }).parse(payload),
      buildNeedsInput: (base) => ({ ...base, kind: 'needs-input' }),
      buildSources: () => ({ nameSource: '/name' }),
    },
  );

  expect(event).toStrictEqual({ kind: 'heartbeat', agentSessionID: toAgentSessionID('c-1') });
});
