import { expect, test } from 'bun:test';
import { normalizeHookEventName } from './normalize-hook-event';

test.each([
  ['SessionStart', 'SessionStart'],
  ['session_start', 'SessionStart'],
  ['stop', 'Stop'],
  ['Stop', 'Stop'],
  ['stop_failure', 'StopFailure'],
  ['stop_cancelled', 'StopCancelled'],
  ['user_prompt_submit', 'UserPromptSubmit'],
  ['UserPromptSubmit', 'UserPromptSubmit'],
  ['notification', 'Notification'],
  ['Notification', 'Notification'],
  ['session_end', 'SessionEnd'],
])('it maps %s to %s', (raw, event) => {
  expect(normalizeHookEventName(raw)).toBe(event);
});
