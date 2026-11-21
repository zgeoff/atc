import { expect, test } from 'bun:test';
import { pickPlaceColour } from './pick-place-colour';

test.each([
  { key: 'cloud:place-v1:4be1c09a2d7e5f10' },
  { key: 'daemon:local:local' },
  { key: 'daemon:lab:dock' },
])('#pickPlaceColour gives $key the same colour on every call', (row) => {
  expect(pickPlaceColour(row.key)).toStrictEqual(pickPlaceColour(row.key));
});

test.each([{ key: 'daemon:local:local' }, { key: 'cloud:place-v1:4be1c09a2d7e5f10' }])(
  '#pickPlaceColour gives $key a palette colour moved 20% toward #6e7681',
  (row) => {
    const colour = pickPlaceColour(row.key);

    const palette = [
      [201, 110, 119],
      [205, 177, 124],
      [144, 180, 123],
      [91, 169, 181],
      [100, 164, 217],
      [180, 120, 203],
      [226, 150, 106],
      [114, 198, 187],
      [172, 147, 223],
      [220, 118, 139],
      [148, 188, 111],
      [122, 189, 230],
    ];

    expect(palette).toContainEqual([
      colour.kind === 'rgb' ? colour.red : -1,
      colour.kind === 'rgb' ? colour.green : -1,
      colour.kind === 'rgb' ? colour.blue : -1,
    ]);
  },
);

test('#pickPlaceColour gives different keys more than one colour', () => {
  const colours = new Set(
    Array.from({ length: 40 }, (_, index) => JSON.stringify(pickPlaceColour(`daemon:d:${index}`))),
  );

  expect(colours.size).toBeGreaterThan(5);
});
