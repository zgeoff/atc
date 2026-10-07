import { expect, test } from 'bun:test';
import { isDaemonProcess } from './is-daemon-process';

test('it rejects a live process that is not an atc daemon', () => {
  expect(isDaemonProcess(process.pid)).toBeFalse();
});

test('it rejects a pid with no process', () => {
  expect(isDaemonProcess(2 ** 22 + 1)).toBeFalse();
});
