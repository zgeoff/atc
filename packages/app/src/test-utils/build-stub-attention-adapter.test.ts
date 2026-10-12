import { expect, test } from 'bun:test';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toSessionID } from '../shared/to-session-id';
import { buildStubAttentionAdapter } from './build-stub-attention-adapter';

test('it builds an adapter whose sessions take messages and resume with claude', () => {
  const adapter = buildStubAttentionAdapter();

  expect(adapter.id).toBe('claude');
  expect(adapter.takesMessages).toBe(true);

  expect(adapter.buildResumeCommand('/nonexistent', toAgentSessionID('c-1'))).toBe(
    'claude --resume',
  );
});

test('it reads a notification hook as needing input', () => {
  expect(
    buildStubAttentionAdapter().normalizeHook({
      atcId: toSessionID('s-1'),
      event: 'Notification',
      payload: { session_id: 'c-1', message: 'hi' },
    }),
  ).toStrictEqual({ kind: 'needs-input' });
});

test.each(['UserPromptSubmit', 'Stop', 'SessionStart'])(
  'it reads a %s hook as a submitted prompt',
  (event) => {
    expect(
      buildStubAttentionAdapter().normalizeHook({
        atcId: toSessionID('s-1'),
        event,
        payload: { session_id: 'c-1' },
      }),
    ).toStrictEqual({ kind: 'prompt-submitted' });
  },
);

test('it applies overrides on top of the defaults', () => {
  expect(buildStubAttentionAdapter({ takesMessages: false }).takesMessages).toBeFalse();
});
