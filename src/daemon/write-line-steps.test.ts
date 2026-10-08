import { expect, mock, test } from 'bun:test';
import { writeLineSteps } from './write-line-steps';

test('it writes every step in order, waiting out each pause, and settles ok', async () => {
  const written: string[] = [];
  const wait = mock(() => Promise.resolve());

  const result = await writeLineSteps(
    ['name', { pauseMs: 100 }, 'argument', '\r'],
    {
      write: (data) => {
        written.push(data);
      },
      isLive: () => true,
    },
    wait,
  );

  expect(result).toBe('ok');
  expect(written).toStrictEqual(['name', 'argument', '\r']);
  expect(wait).toHaveBeenCalledExactlyOnceWith(100);
});

test('it writes the steps before the first pause before the call returns', () => {
  const written: string[] = [];
  const pause = Promise.withResolvers<void>();

  void writeLineSteps(
    ['name', { pauseMs: 100 }, 'argument'],
    {
      write: (data) => {
        written.push(data);
      },
      isLive: () => true,
    },
    () => pause.promise,
  );

  expect(written).toStrictEqual(['name']);
});

test('it stops with dead when the terminal is gone after a pause', async () => {
  const written: string[] = [];
  let live = true;

  const result = await writeLineSteps(
    ['name', { pauseMs: 100 }, 'argument', '\r'],
    {
      write: (data) => {
        written.push(data);
      },
      isLive: () => live,
    },
    () => {
      live = false;

      return Promise.resolve();
    },
  );

  expect(result).toBe('dead');
  expect(written).toStrictEqual(['name']);
});
