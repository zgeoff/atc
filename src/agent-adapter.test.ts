import { expect, test } from 'bun:test';
import { parseAgentKind } from './agent-adapter';

test.each([
  ['claude', 'claude'],
  ['grok', 'grok'],
  ['codex', 'codex'],
])('it parses %s as the %s agent kind', (raw, expected) => {
  expect(parseAgentKind(raw)).toBe(expected);
});

test.each([[undefined], [null], [''], ['gemini'], [42]])(
  'it rejects %p as no known agent kind',
  (raw) => {
    expect(parseAgentKind(raw)).toBeNull();
  },
);
