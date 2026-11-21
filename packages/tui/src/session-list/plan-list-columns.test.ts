import { expect, test } from 'bun:test';
import { planListColumns } from './plan-list-columns';

test.each([
  {
    title: 'every column in a wide panel',
    input: {
      contentWidth: 108,
      isNarrow: false,
      showDaemon: true,
      showRepo: true,
      wants: { name: 16, daemon: 6, place: 7, repo: 8, agent: 6 },
    },
    expected: { name: 16, daemon: 6, place: 7, repo: 8, agent: 6, message: 46, age: 4 },
  },
  {
    title: 'no daemon column with one daemon',
    input: {
      contentWidth: 108,
      isNarrow: false,
      showDaemon: false,
      showRepo: true,
      wants: { name: 16, daemon: 6, place: 7, repo: 8, agent: 6 },
    },
    expected: { name: 16, daemon: 0, place: 7, repo: 8, agent: 6, message: 54, age: 4 },
  },
  {
    title: 'no repository column in repo mode',
    input: {
      contentWidth: 108,
      isNarrow: false,
      showDaemon: false,
      showRepo: false,
      wants: { name: 16, daemon: 6, place: 7, repo: 8, agent: 6 },
    },
    expected: { name: 16, daemon: 0, place: 7, repo: 0, agent: 6, message: 64, age: 4 },
  },
  {
    title: 'no place column when no row fills it',
    input: {
      contentWidth: 108,
      isNarrow: false,
      showDaemon: false,
      showRepo: true,
      wants: { name: 16, daemon: 6, place: 0, repo: 8, agent: 6 },
    },
    expected: { name: 16, daemon: 0, place: 0, repo: 8, agent: 6, message: 63, age: 4 },
  },
  {
    title: 'only the name, the message and the age in a narrow panel',
    input: {
      contentWidth: 76,
      isNarrow: true,
      showDaemon: true,
      showRepo: true,
      wants: { name: 16, daemon: 6, place: 7, repo: 8, agent: 6 },
    },
    expected: { name: 16, daemon: 0, place: 0, repo: 0, agent: 0, message: 49, age: 4 },
  },
  {
    title: 'the agent dropped when the message would get too little',
    input: {
      contentWidth: 60,
      isNarrow: false,
      showDaemon: false,
      showRepo: true,
      wants: { name: 16, daemon: 6, place: 7, repo: 8, agent: 6 },
    },
    expected: { name: 16, daemon: 0, place: 7, repo: 8, agent: 0, message: 14, age: 4 },
  },
])('#planListColumns gives $title', (row) => {
  expect(planListColumns(row.input)).toStrictEqual(row.expected);
});
