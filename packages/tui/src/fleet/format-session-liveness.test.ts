import { expect, test } from 'bun:test';
import { formatSessionLiveness } from './format-session-liveness';

test('#formatSessionLiveness lists the sessions of the named daemon with their liveness', () => {
  expect(
    formatSessionLiveness(
      [
        { daemon: null, id: 's-1', alive: true },
        { daemon: 'box', id: 's-2', alive: true },
        { daemon: null, id: 's-3', alive: false },
      ],
      null,
    ),
  ).toBe('s-1:live,s-3:dead');
});
