import { expect, test } from 'bun:test';
import { pickDefaultAgent } from './pick-default-agent';

test('it opens on the last-used agent when its binary resolves', () => {
  expect(
    pickDefaultAgent(
      [
        { agent: 'claude', label: 'Claude', bin: 'claude', binPath: '/usr/bin/claude' },
        { agent: 'grok', label: 'Grok', bin: 'grok', binPath: '/usr/bin/grok' },
        { agent: 'codex', label: 'Codex', bin: 'codex', binPath: null },
      ],
      'grok',
    ),
  ).toBe('grok');
});

test('it opens on the first installed agent when the last-used one is missing', () => {
  expect(
    pickDefaultAgent(
      [
        { agent: 'claude', label: 'Claude', bin: 'claude', binPath: null },
        { agent: 'grok', label: 'Grok', bin: 'grok', binPath: '/usr/bin/grok' },
        { agent: 'codex', label: 'Codex', bin: 'codex', binPath: null },
      ],
      'codex',
    ),
  ).toBe('grok');
});

test('it keeps the last-used agent when no binary resolves', () => {
  expect(
    pickDefaultAgent(
      [
        { agent: 'claude', label: 'Claude', bin: 'claude', binPath: null },
        { agent: 'grok', label: 'Grok', bin: 'grok', binPath: null },
        { agent: 'codex', label: 'Codex', bin: 'codex', binPath: null },
      ],
      'codex',
    ),
  ).toBe('codex');
});
