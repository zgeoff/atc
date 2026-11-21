import { expect, test } from 'bun:test';
import { filterMouseReports } from './filter-mouse-reports';

test.each<{ name: string; data: string; expected: string }>([
  { name: 'keeps a key', data: 'a', expected: 'a' },
  {
    name: 'keeps an sgr press inside the area',
    data: '\u001B[<0;10;5M',
    expected: '\u001B[<0;10;5M',
  },
  {
    name: 'keeps an sgr release on the last PTY row',
    data: '\u001B[<0;80;24m',
    expected: '\u001B[<0;80;24m',
  },
  { name: 'drops an sgr press in the fleet bar row', data: '\u001B[<0;10;25M', expected: '' },
  { name: 'drops an sgr press right of the area', data: '\u001B[<0;81;3M', expected: '' },
  { name: 'drops a urxvt press below the area', data: '\u001B[32;10;30M', expected: '' },
  {
    name: 'keeps a urxvt press inside the area',
    data: '\u001B[32;10;3M',
    expected: '\u001B[32;10;3M',
  },
  {
    name: 'keeps a default-encoding press inside the area',
    data: '\u001B[M #"',
    expected: '\u001B[M #"',
  },
  { name: 'drops a default-encoding press below the area', data: '\u001B[M #9', expected: '' },
  {
    name: 'drops only the report outside among several',
    data: '\u001B[<0;1;1M\u001B[<0;1;30Mx',
    expected: '\u001B[<0;1;1Mx',
  },
  {
    name: 'keeps report-like text inside a bracketed paste',
    data: '\u001B[200~log \u001B[<0;200;3M done\u001B[201~',
    expected: '\u001B[200~log \u001B[<0;200;3M done\u001B[201~',
  },
  {
    name: 'drops a report after a bracketed paste ends',
    data: '\u001B[200~p\u001B[201~\u001B[<0;1;30M',
    expected: '\u001B[200~p\u001B[201~',
  },
])('#filterMouseReports $name', (row) => {
  expect(filterMouseReports(row.data, { cols: 80, rows: 24 }, false)).toStrictEqual({
    data: row.expected,
    isInPaste: false,
  });
});

test('#filterMouseReports keeps a paste open at the end of a chunk', () => {
  expect(
    filterMouseReports('\u001B[<0;1;30M\u001B[200~\u001B[<0;1;30M', { cols: 80, rows: 24 }, false),
  ).toStrictEqual({ data: '\u001B[200~\u001B[<0;1;30M', isInPaste: true });
});

test('#filterMouseReports passes a chunk inside a paste that opened in an earlier chunk', () => {
  expect(
    filterMouseReports('\u001B[<0;1;30M\u001B[201~\u001B[<0;1;30M', { cols: 80, rows: 24 }, true),
  ).toStrictEqual({ data: '\u001B[<0;1;30M\u001B[201~', isInPaste: false });
});
