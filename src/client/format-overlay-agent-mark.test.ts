import { expect, test } from 'bun:test';
import { formatOverlayAgentMark } from './format-overlay-agent-mark';

test('it marks a grok row with g and a claude row with a space', () => {
  expect(formatOverlayAgentMark('grok')).toBe('g');
  expect(formatOverlayAgentMark('claude')).toBe(' ');
});

test('it marks a configured backend with the letter that backend was given', () => {
  expect(formatOverlayAgentMark('zai', { zai: 'z' })).toBe('z');
});

test('it marks an agent with no configured letter with a space', () => {
  expect(formatOverlayAgentMark('kimi', { zai: 'z' })).toBe(' ');
});
