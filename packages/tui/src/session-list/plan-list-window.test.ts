import { expect, test } from 'bun:test';
import { planListWindow } from './plan-list-window';

test.each([
  { title: 'every line when they fit', count: 5, capacity: 8, selected: 3, expected: [0, 5] },
  {
    title: 'the top lines for a selection near the top',
    count: 20,
    capacity: 8,
    selected: 1,
    expected: [0, 8],
  },
  { title: 'the selection in the middle', count: 20, capacity: 8, selected: 10, expected: [6, 14] },
  {
    title: 'the bottom lines for a selection near the bottom',
    count: 20,
    capacity: 8,
    selected: 19,
    expected: [12, 20],
  },
])('#planListWindow gives $title', (row) => {
  const window = planListWindow(row.count, row.capacity, row.selected);

  expect([window.start, window.end]).toStrictEqual([...row.expected]);
});
