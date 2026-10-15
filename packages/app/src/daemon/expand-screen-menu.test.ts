import { expect, test } from 'bun:test';
import { expandScreenMenu } from './expand-screen-menu';

test('it numbers the rows of a scrolled window by their place in the whole list', () => {
  const part = {
    text: '5 new MCP servers found in this project',
    options: [
      { label: 'orchard-search', checked: true },
      { label: 'quarry-files', checked: true },
      { label: 'lantern-docs', checked: true },
      { label: 'Enable selected', checked: null },
    ],
    highlighted: 1,
    scroll: { above: true, below: true },
  };

  const whole = {
    text: '5 new MCP servers found in this project',
    options: [
      { label: 'kettle-notes', checked: true },
      { label: 'orchard-search', checked: true },
      { label: 'quarry-files', checked: true },
      { label: 'lantern-docs', checked: true },
      { label: 'meadow-index', checked: true },
      { label: 'Enable selected', checked: null },
    ],
    highlighted: 0,
  };

  expect(expandScreenMenu(part, whole)).toStrictEqual({
    text: '5 new MCP servers found in this project',
    options: [
      { label: 'kettle-notes', checked: true },
      { label: 'orchard-search', checked: true },
      { label: 'quarry-files', checked: true },
      { label: 'lantern-docs', checked: true },
      { label: 'meadow-index', checked: true },
      { label: 'Enable selected', checked: null },
    ],
    highlighted: 2,
  });
});

test('it takes the boxes the window shows and keeps the boxes out of view', () => {
  const part = {
    text: '4 new MCP servers found in this project',
    options: [
      { label: 'quarry-files', checked: false },
      { label: 'lantern-docs', checked: true },
      { label: 'Enable selected', checked: null },
    ],
    highlighted: 0,
    scroll: { above: true, below: false },
  };

  const whole = {
    text: '4 new MCP servers found in this project',
    options: [
      { label: 'kettle-notes', checked: false },
      { label: 'orchard-search', checked: true },
      { label: 'quarry-files', checked: true },
      { label: 'lantern-docs', checked: true },
      { label: 'Enable selected', checked: null },
    ],
    highlighted: 4,
  };

  expect(expandScreenMenu(part, whole)?.options).toStrictEqual([
    { label: 'kettle-notes', checked: false },
    { label: 'orchard-search', checked: true },
    { label: 'quarry-files', checked: false },
    { label: 'lantern-docs', checked: true },
    { label: 'Enable selected', checked: null },
  ]);
});

test('it numbers the cursor on the item after the list after the whole list', () => {
  const part = {
    text: '4 new MCP servers found in this project',
    options: [
      { label: 'quarry-files', checked: true },
      { label: 'lantern-docs', checked: true },
      { label: 'Enable selected', checked: null },
    ],
    highlighted: 2,
    scroll: { above: true, below: false },
  };

  const whole = {
    text: '4 new MCP servers found in this project',
    options: [
      { label: 'kettle-notes', checked: true },
      { label: 'orchard-search', checked: true },
      { label: 'quarry-files', checked: true },
      { label: 'lantern-docs', checked: true },
      { label: 'Enable selected', checked: null },
    ],
    highlighted: 0,
  };

  expect(expandScreenMenu(part, whole)?.highlighted).toBe(4);
});

test('it places a window without marks whose cursor hides the mark below', () => {
  const part = {
    text: 'Pick a colour',
    options: [
      { label: 'Amber', checked: null },
      { label: 'Teal', checked: null },
    ],
    highlighted: 1,
  };

  const whole = {
    text: 'Pick a colour',
    options: [
      { label: 'Amber', checked: null },
      { label: 'Teal', checked: null },
      { label: 'Plum', checked: null },
    ],
    highlighted: 0,
  };

  expect(expandScreenMenu(part, whole)).toStrictEqual({
    text: 'Pick a colour',
    options: [
      { label: 'Amber', checked: null },
      { label: 'Teal', checked: null },
      { label: 'Plum', checked: null },
    ],
    highlighted: 1,
  });
});

test('it finds no whole menu for a window with other text', () => {
  const part = {
    text: 'Pick a shade',
    options: [
      { label: 'Amber', checked: null },
      { label: 'Teal', checked: null },
    ],
    highlighted: 0,
    scroll: { above: false, below: true },
  };

  const whole = {
    text: 'Pick a colour',
    options: [
      { label: 'Amber', checked: null },
      { label: 'Teal', checked: null },
      { label: 'Plum', checked: null },
    ],
    highlighted: 0,
  };

  expect(expandScreenMenu(part, whole)).toBeNull();
});

test('it finds no whole menu when the window marks options below that the list lacks', () => {
  const part = {
    text: 'Pick a colour',
    options: [
      { label: 'Teal', checked: null },
      { label: 'Plum', checked: null },
    ],
    highlighted: 0,
    scroll: { above: true, below: true },
  };

  const whole = {
    text: 'Pick a colour',
    options: [
      { label: 'Amber', checked: null },
      { label: 'Teal', checked: null },
      { label: 'Plum', checked: null },
    ],
    highlighted: 0,
  };

  expect(expandScreenMenu(part, whole)).toBeNull();
});
