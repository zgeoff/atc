import type { Coverage } from './types';

// A cell is two pixels tall, so an odd count of rows gets an empty row on top.
export function padToEvenRows(coverage: Coverage): Coverage {
  const width = coverage[0]?.length ?? 0;

  return coverage.length % 2 === 0
    ? coverage
    : [Array.from({ length: width }, () => 0), ...coverage];
}
