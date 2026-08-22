import { expect, test } from 'bun:test';
import { formatAgentPick } from './format-agent-pick';

test('it labels an installed agent with its plain name', () => {
  expect(
    formatAgentPick({ agent: 'grok', label: 'Grok', bin: 'grok', binPath: '/usr/bin/grok' }),
  ).toBe('Grok');
});

test('it marks an agent whose binary does not resolve as not installed', () => {
  expect(formatAgentPick({ agent: 'codex', label: 'Codex', bin: 'codex', binPath: null })).toBe(
    'Codex — not installed',
  );
});
