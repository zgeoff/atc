import { expect, test } from 'bun:test';
import { pickDistinctLabels } from './pick-distinct-labels';

test.each([
  {
    title: 'each label as it is when no two match',
    candidates: [
      { label: 'shop', qualifiers: ['local'] },
      { label: 'kite', qualifiers: ['local'] },
    ],
    expected: ['shop', 'kite'],
  },
  {
    title: 'qualifiers added one at a time until two labels differ',
    candidates: [
      { label: 'shop', qualifiers: ['local', 'first'] },
      { label: 'shop', qualifiers: ['local', 'second'] },
    ],
    expected: ['shop · local · first', 'shop · local · second'],
  },
  {
    title: 'a further qualifier on a label that a qualifier made match another',
    candidates: [
      { label: 'cloud', qualifiers: ['lab', 'one'] },
      { label: 'cloud', qualifiers: ['box', 'two'] },
      { label: 'cloud · lab', qualifiers: ['three'] },
    ],
    expected: ['cloud · lab · one', 'cloud · box', 'cloud · lab · three'],
  },
  {
    title: 'every qualifier on two labels that never differ',
    candidates: [
      { label: 'shop', qualifiers: ['local'] },
      { label: 'shop', qualifiers: ['local'] },
    ],
    expected: ['shop · local', 'shop · local'],
  },
])('#pickDistinctLabels gives $title', (row) => {
  expect(pickDistinctLabels(row.candidates)).toStrictEqual([...row.expected]);
});
