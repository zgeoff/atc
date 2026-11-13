import { expect, test } from 'bun:test';
import { createSessionMap } from './create-session-map';

test('it keeps one value per daemon for the same session id', () => {
  const map = createSessionMap<number>();

  map.set({ daemon: null, id: 's-1' }, 1);
  map.set({ daemon: 'box', id: 's-1' }, 2);

  expect([
    map.get({ daemon: null, id: 's-1' }),
    map.get({ daemon: 'box', id: 's-1' }),
    map.get({ daemon: 'lab', id: 's-1' }),
  ]).toStrictEqual([1, 2, undefined]);
});

test('it keeps the local daemon apart from a daemon named like the empty string', () => {
  const map = createSessionMap<number>();

  map.set({ daemon: null, id: 's-1' }, 1);

  expect(map.get({ daemon: '', id: 's-1' })).toBeUndefined();
});

test('it deletes only the key it is given', () => {
  const map = createSessionMap<number>();

  map.set({ daemon: null, id: 's-1' }, 1);
  map.set({ daemon: 'box', id: 's-1' }, 2);
  map.remove({ daemon: 'box', id: 's-1' });

  expect([
    map.get({ daemon: null, id: 's-1' }),
    map.get({ daemon: 'box', id: 's-1' }),
  ]).toStrictEqual([1, undefined]);
});
