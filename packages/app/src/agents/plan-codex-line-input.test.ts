import { expect, test } from 'bun:test';
import { KEYS } from '../test-utils/keys';
import { planCodexLineInput } from './plan-codex-line-input';

test('it pastes a slash command name, pauses, then pastes its argument and submits', () => {
  const argument = 'a'.repeat(1994);

  expect(planCodexLineInput(`/goal ${argument}`, { bracketedPaste: true })).toStrictEqual([
    `${KEYS.pasteOpen}/goal ${KEYS.pasteClose}`,
    { pauseMs: 100 },
    `${KEYS.pasteOpen}${argument}${KEYS.pasteClose}`,
    KEYS.enter,
  ]);
});

test('it drops paste markers from a slash command argument', () => {
  expect(
    planCodexLineInput(`/goal a${KEYS.pasteClose}b${KEYS.pasteOpen}c`, { bracketedPaste: true }),
  ).toStrictEqual([
    `${KEYS.pasteOpen}/goal ${KEYS.pasteClose}`,
    { pauseMs: 100 },
    `${KEYS.pasteOpen}abc${KEYS.pasteClose}`,
    KEYS.enter,
  ]);
});

test('it pastes a line without a leading slash command whole and submits it', () => {
  expect(planCodexLineInput('first\nsecond', { bracketedPaste: true })).toStrictEqual([
    `${KEYS.pasteOpen}first\nsecond${KEYS.pasteClose}`,
    KEYS.enter,
  ]);
});

test('it pastes a slash command without an argument whole', () => {
  expect(planCodexLineInput('/clear', { bracketedPaste: true })).toStrictEqual([
    `${KEYS.pasteOpen}/clear${KEYS.pasteClose}`,
    KEYS.enter,
  ]);
});

test('it pastes a line that starts with a path whole', () => {
  expect(planCodexLineInput('/tmp/out holds the log', { bracketedPaste: true })).toStrictEqual([
    `${KEYS.pasteOpen}/tmp/out holds the log${KEYS.pasteClose}`,
    KEYS.enter,
  ]);
});

test('it writes a slash command unmarked to a TUI without bracketed paste', () => {
  expect(planCodexLineInput('/goal finish it', { bracketedPaste: false })).toStrictEqual([
    '/goal finish it',
    KEYS.enter,
  ]);
});
