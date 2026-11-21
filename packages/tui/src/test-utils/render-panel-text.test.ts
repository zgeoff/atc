import { expect, test } from 'bun:test';
import { renderPanelText } from './render-panel-text';

test('#renderPanelText lays each span at its column and gives one string for each line', () => {
  const text = renderPanelText({
    left: 0,
    top: 0,
    width: 8,
    topBorder: {
      spans: [{ col: 1, text: 'top', fg: { red: 0, green: 0, blue: 0 }, bold: false }],
      isSelected: false,
    },
    content: [
      {
        spans: [{ col: 2, text: 'a界', fg: { red: 0, green: 0, blue: 0 }, bold: false }],
        isSelected: false,
      },
    ],
    divider: {
      spans: [{ col: 0, text: 'mid', fg: { red: 0, green: 0, blue: 0 }, bold: false }],
      isSelected: false,
    },
    lastLines: [
      {
        spans: [{ col: 3, text: 'last', fg: { red: 0, green: 0, blue: 0 }, bold: false }],
        isSelected: false,
      },
    ],
    bottomBorder: {
      spans: [{ col: 5, text: 'end', fg: { red: 0, green: 0, blue: 0 }, bold: false }],
      isSelected: false,
    },
    isSpinning: false,
    nextAgeChangeAtMs: null,
  });

  expect(text).toStrictEqual([' top', '  a界', 'mid', '   last', '     end']);
});

test('#renderPanelText leaves out the borders a plan dropped', () => {
  const text = renderPanelText({
    left: 0,
    top: 0,
    width: 8,
    topBorder: null,
    content: [],
    divider: null,
    lastLines: [
      {
        spans: [{ col: 1, text: 'last', fg: { red: 0, green: 0, blue: 0 }, bold: false }],
        isSelected: false,
      },
    ],
    bottomBorder: null,
    isSpinning: false,
    nextAgeChangeAtMs: null,
  });

  expect(text).toStrictEqual([' last']);
});
