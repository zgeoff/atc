import { expect, test } from 'bun:test';
import { KEYS } from '@atc/core/test-utils/keys';
import { buildStubTerminal } from '../test-utils/build-stub-terminal';
import { drawPicker } from './draw-picker';

test('#drawPicker scrolls to a selection past the tenth item and counts the items above it', () => {
  const terminal = buildStubTerminal();

  drawPicker(
    {
      title: 'spawn: agent',
      items: Array.from({ length: 14 }, (_, index) => `agent-${index + 1}`),
      selected: 12,
      input: '',
      hint: '⏎ pick · esc cancel',
    },
    terminal.write,
  );

  const contentRows = terminal
    .getText()
    .replaceAll(KEYS.esc, '')
    .split(/\[[0-9;]+H/u)
    .map((row) => row.replaceAll(/\[[0-9;?]*[A-Za-z]/gu, '').trim())
    .filter((row) => row.startsWith('│'))
    .map((row) => row.slice(1, -1).trim());

  expect(contentRows).toStrictEqual([
    '↑ 5 more',
    'agent-6',
    'agent-7',
    'agent-8',
    'agent-9',
    'agent-10',
    'agent-11',
    'agent-12',
    'agent-13',
    'agent-14',
    '> █',
    '⏎ pick · esc cancel',
  ]);
});

test('#drawPicker keeps both counts and the selection inside ten rows mid-list', () => {
  const terminal = buildStubTerminal();

  drawPicker(
    {
      title: 'spawn: repository',
      items: Array.from({ length: 20 }, (_, index) => `acme/tool-${index + 1}`),
      selected: 11,
      input: '',
      hint: '⏎ pick · esc cancel',
    },
    terminal.write,
  );

  const contentRows = terminal
    .getText()
    .replaceAll(KEYS.esc, '')
    .split(/\[[0-9;]+H/u)
    .map((row) => row.replaceAll(/\[[0-9;?]*[A-Za-z]/gu, '').trim())
    .filter((row) => row.startsWith('│'))
    .map((row) => row.slice(1, -1).trim());

  expect(contentRows).toStrictEqual([
    '↑ 4 more',
    'acme/tool-5',
    'acme/tool-6',
    'acme/tool-7',
    'acme/tool-8',
    'acme/tool-9',
    'acme/tool-10',
    'acme/tool-11',
    'acme/tool-12',
    '↓ 8 more',
    '> █',
    '⏎ pick · esc cancel',
  ]);
});

test('#drawPicker draws every item and no count when ten items fit', () => {
  const terminal = buildStubTerminal();

  drawPicker(
    {
      title: 'spawn: agent',
      items: Array.from({ length: 10 }, (_, index) => `agent-${index + 1}`),
      selected: 9,
      input: '',
      hint: '⏎ pick · esc cancel',
    },
    terminal.write,
  );

  const contentRows = terminal
    .getText()
    .replaceAll(KEYS.esc, '')
    .split(/\[[0-9;]+H/u)
    .map((row) => row.replaceAll(/\[[0-9;?]*[A-Za-z]/gu, '').trim())
    .filter((row) => row.startsWith('│'))
    .map((row) => row.slice(1, -1).trim());

  expect(contentRows).toStrictEqual([
    'agent-1',
    'agent-2',
    'agent-3',
    'agent-4',
    'agent-5',
    'agent-6',
    'agent-7',
    'agent-8',
    'agent-9',
    'agent-10',
    '> █',
    '⏎ pick · esc cancel',
  ]);
});
