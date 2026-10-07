import { expect, onTestFinished, test } from 'bun:test';
import { buildStubChannelOpener } from './build-stub-channel-opener';

test('it opens each dial with the opener at its position', async () => {
  const opener = buildStubChannelOpener([
    (address: string) => Promise.resolve(`first ${address}`),
    (address: string) => Promise.resolve(`second ${address}`),
  ]);

  const opened = [await opener.open('a'), await opener.open('b')];

  expect(opened).toStrictEqual(['first a', 'second b']);
});

test('it opens every dial past the list with the last opener', async () => {
  const opener = buildStubChannelOpener([
    (address: string) => Promise.resolve(`first ${address}`),
    (address: string) => Promise.resolve(`later ${address}`),
  ]);

  await opener.open('a');
  await opener.open('b');

  const third = await opener.open('c');

  expect(third).toBe('later c');
});

test('it counts every dial it made', async () => {
  const opener = buildStubChannelOpener([(address: string) => Promise.resolve(address)]);

  await opener.open('a');
  await opener.open('b');

  expect(opener.countOpened()).toBe(2);
});

test('it counts a dial whose opener rejects', () => {
  const opener = buildStubChannelOpener([
    (address: string) => Promise.reject(new Error(`refused ${address}`)),
  ]);

  expect(opener.open('a')).rejects.toThrowWithMessage(Error, 'refused a');
  expect(opener.countOpened()).toBe(1);
});

test('it holds the dial at the hold position until it is released', async () => {
  const opener = buildStubChannelOpener([(address: string) => Promise.resolve(address)], {
    holdDial: 2,
  });

  await opener.open('a');

  const second = opener.open('b');

  await opener.waitForHeld();

  opener.releaseHeld();

  expect(second).resolves.toBe('b');
});

test('it opens no held dial before it is released', async () => {
  const opened: string[] = [];

  const opener = buildStubChannelOpener(
    [
      (address: string) => {
        opened.push(address);

        return Promise.resolve(address);
      },
    ],
    { holdDial: 1 },
  );

  void opener.open('a');

  onTestFinished(() => {
    opener.releaseHeld();
  });

  await opener.waitForHeld();

  expect(opened).toStrictEqual([]);
});
