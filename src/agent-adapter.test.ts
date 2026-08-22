import { expect, test } from 'bun:test';
import type { AgentKind } from './agent-adapter';
import { parseAgentKind } from './agent-adapter';

test.each<readonly [AgentKind]>([['claude'], ['grok'], ['codex']])(
  'it parses %s as itself',
  (kind) => {
    expect(parseAgentKind(kind)).toBe(kind);
  },
);

test.each([[undefined], [null], [''], ['gemini'], [42]])(
  'it rejects %p as no known agent kind',
  (raw) => {
    expect(parseAgentKind(raw)).toBeNull();
  },
);
