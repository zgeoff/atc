import { expect, test } from 'bun:test';
import { buildMockPanelInput } from './build-mock-panel-input';

test('it builds a panel input with no rows, nothing selected and no line over the key bar', () => {
  const input = buildMockPanelInput();

  expect({
    rows: input.rows,
    selected: input.selected,
    prompt: input.prompt,
    notice: input.notice,
  }).toStrictEqual({ rows: [], selected: -1, prompt: null, notice: null });
});

test('it applies overrides on top of the defaults', () => {
  expect(buildMockPanelInput({ grouping: 'place', selected: 2 })).toMatchObject({
    grouping: 'place',
    selected: 2,
    filter: null,
  });
});
