import { expect, test } from 'bun:test';
import { pickSessionState } from './pick-session-state';

test('it lists a running harness with the attention its hooks reported', () => {
  expect(
    pickSessionState(
      { desired: 'run', vm: 'none', harness: 'running', attachment: 'local' },
      'needs_you',
    ),
  ).toBe('needs_you');
});

test('it lists a suspended harness as exited whatever its last attention was', () => {
  expect(
    pickSessionState(
      { desired: 'sleep', vm: 'asleep', harness: 'suspended', attachment: 'detached' },
      'done',
    ),
  ).toBe('exited');
});

test('it lists an exited harness as exited whatever its last attention was', () => {
  expect(
    pickSessionState(
      { desired: 'run', vm: 'none', harness: 'exited', attachment: 'local' },
      'running',
    ),
  ).toBe('exited');
});
