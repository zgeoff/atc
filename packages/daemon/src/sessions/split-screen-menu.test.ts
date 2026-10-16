import { expect, test } from 'bun:test';
import { splitScreenMenu } from './split-screen-menu';

test('it puts the items without a box after the last box after the list', () => {
  const menu = {
    text: '2 new MCP servers found in this project',
    options: [
      { label: 'kettle-notes', checked: true },
      { label: 'quarry-files', checked: false },
      { label: 'Enable selected', checked: null },
    ],
    highlighted: 0,
  };

  expect(splitScreenMenu(menu)).toStrictEqual({
    list: [
      { label: 'kettle-notes', checked: true },
      { label: 'quarry-files', checked: false },
    ],
    after: [{ label: 'Enable selected', checked: null }],
  });
});

test('it puts every option of a menu without boxes in the list', () => {
  const menu = {
    text: 'Pick a colour',
    options: [
      { label: 'Amber', checked: null },
      { label: 'Teal', checked: null },
    ],
    highlighted: 1,
  };

  expect(splitScreenMenu(menu)).toStrictEqual({
    list: [
      { label: 'Amber', checked: null },
      { label: 'Teal', checked: null },
    ],
    after: [],
  });
});
