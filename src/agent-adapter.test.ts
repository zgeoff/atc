import { expect, test } from 'bun:test';
import { toAgentID } from './agent-adapter';

test.each([['claude'], ['grok'], ['codex'], ['zai'], ['gemini']])(
  'it reads %p as itself',
  (raw) => {
    expect(toAgentID(raw)).toBe(raw);
  },
);

test.each([[undefined], [null], [''], [42]])('it reads %p as claude', (raw) => {
  expect(toAgentID(raw)).toBe('claude');
});
