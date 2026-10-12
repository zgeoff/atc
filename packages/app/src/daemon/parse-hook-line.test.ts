import { expect, test } from 'bun:test';
import { toSessionID } from '../shared/to-session-id';
import { parseHookLine } from './parse-hook-line';

test('it parses the agent a hook line carries', () => {
  const line = JSON.stringify({ atcId: 's-1', agent: 'codex', event: 'Stop', payload: {} });

  expect(parseHookLine(line)).toStrictEqual({
    atcId: toSessionID('s-1'),
    agent: 'codex',
    event: 'Stop',
    payload: {},
  });
});

test('it parses a hook line without an agent', () => {
  const line = JSON.stringify({ atcId: 's-1', event: 'Stop', payload: {} });

  expect(parseHookLine(line)).toStrictEqual({
    atcId: toSessionID('s-1'),
    event: 'Stop',
    payload: {},
  });
});

test('it leaves out an agent that is not a non-empty string', () => {
  const line = JSON.stringify({ atcId: 's-1', agent: 7, event: 'Stop', payload: {} });

  expect(parseHookLine(line)).toStrictEqual({
    atcId: toSessionID('s-1'),
    event: 'Stop',
    payload: {},
  });
});

test('it rejects a line that is not JSON', () => {
  expect(parseHookLine('not json')).toBeNull();
});

test('it rejects a line without a session', () => {
  expect(parseHookLine(JSON.stringify({ event: 'Stop', payload: {} }))).toBeNull();
});
