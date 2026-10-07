import { expect, test } from 'bun:test';
import { parseClaudeTranscriptLine } from './parse-claude-transcript-line';

test('it reads a user prompt line as a user row', () => {
  const line =
    '{"type":"user","message":{"role":"user","content":"fix the auth bug"},"timestamp":"2026-10-01T10:00:00.000Z"}';

  expect(parseClaudeTranscriptLine(line)).toStrictEqual({
    role: 'user',
    text: 'fix the auth bug',
    tools: [],
    at: Date.parse('2026-10-01T10:00:00.000Z'),
  });
});

test('it reads assistant text and summarises its tool uses', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Running the tests.' },
        {
          type: 'tool_use',
          id: 't1',
          name: 'Bash',
          input: { command: 'bun test', description: 'Run tests' },
        },
      ],
    },
  });

  expect(parseClaudeTranscriptLine(line)).toStrictEqual({
    role: 'assistant',
    text: 'Running the tests.',
    tools: [{ name: 'Bash', input: 'bun test' }],
    at: null,
  });
});

test('it summarises a tool use with no known input key as its JSON', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 't1', name: 'Odd', input: { a: 1 } }] },
  });

  expect(parseClaudeTranscriptLine(line)).toStrictEqual({
    role: 'assistant',
    text: '',
    tools: [{ name: 'Odd', input: '{"a":1}' }],
    at: null,
  });
});

test.each([
  [
    '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}',
  ],
  [
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hm"}]}}',
  ],
  ['{"type":"assistant","isSidechain":true,"message":{"role":"assistant","content":"sub"}}'],
  ['{"type":"user","isMeta":true,"message":{"role":"user","content":"meta"}}'],
  ['{"type":"summary","summary":"x"}'],
  ['{"type":"custom-title","customTitle":"x"}'],
  ['{"type":'],
  ['[]'],
])('it reads the line %s as no row', (line) => {
  expect(parseClaudeTranscriptLine(line)).toBeNull();
});

test('it reads a row with no time when a line has no timestamp', () => {
  const line = '{"type":"user","message":{"role":"user","content":"hi"}}';

  expect(parseClaudeTranscriptLine(line)).toStrictEqual({
    role: 'user',
    text: 'hi',
    tools: [],
    at: null,
  });
});

test('it truncates row text past 16 KiB', () => {
  const line = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: 'a'.repeat(20_000) },
  });

  expect(parseClaudeTranscriptLine(line)).toStrictEqual({
    role: 'user',
    text: `${'a'.repeat(16_381)}…`,
    tools: [],
    at: null,
  });
});
