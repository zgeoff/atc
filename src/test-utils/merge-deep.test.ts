import { expect, test } from 'bun:test';
import { mergeDeep } from './merge-deep';

test('it keeps every default an override leaves out', () => {
  expect(mergeDeep({ name: 'a', cwd: '/tmp' }, { name: 'b' })).toStrictEqual({
    name: 'b',
    cwd: '/tmp',
  });
});

test('it merges a nested object key by key', () => {
  expect(
    mergeDeep<{ env: Record<string, string>; label: string }>(
      { env: { A: '1', B: '2' }, label: 'x' },
      { env: { B: '3', C: '4' } },
    ),
  ).toStrictEqual({ env: { A: '1', B: '3', C: '4' }, label: 'x' });
});

test('it merges at every depth', () => {
  expect(
    mergeDeep({ auth: { gateway: { id: 'g', host: 'h' } } }, { auth: { gateway: { host: 'k' } } }),
  ).toStrictEqual({ auth: { gateway: { id: 'g', host: 'k' } } });
});

test('it replaces an array whole', () => {
  expect(mergeDeep({ args: ['a', 'b'] }, { args: ['c'] })).toStrictEqual({ args: ['c'] });
});

test('it replaces a class instance whole', () => {
  const replacement = new Map([['b', 2]]);

  expect(mergeDeep({ map: new Map([['a', 1]]) }, { map: replacement }).map).toBe(replacement);
});

test('it adds an override key the defaults lack', () => {
  expect(
    mergeDeep<{ id: string; baseURL?: string }>({ id: 'a' }, { baseURL: 'https://x' }),
  ).toStrictEqual({ id: 'a', baseURL: 'https://x' });
});

test('it leaves the defaults unchanged', () => {
  const defaults = { env: { A: '1' } };

  mergeDeep(defaults, { env: { A: '2' } });

  expect(defaults).toStrictEqual({ env: { A: '1' } });
});
