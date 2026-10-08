import { expect, test } from 'bun:test';
import { buildStubPickerHost } from './build-stub-picker-host';

test('it records no reaction before the picker reacts', () => {
  const host = buildStubPickerHost();

  expect(host.counts).toStrictEqual({ renders: 0, exits: 0, attached: 0, drops: 0 });
  expect(host.dropped).toStrictEqual([]);
  expect(host.countReactions()).toBe(0);
});

test('it counts each reaction and keeps the kind of each dropped answer in order', async () => {
  const host = buildStubPickerHost();

  host.scheduleStatus();
  host.scheduleStatus();
  host.toBase();

  await host.attach();

  host.onDropAnswer('probe');
  host.onDropAnswer('spawn');

  expect(host.counts).toStrictEqual({ renders: 2, exits: 1, attached: 1, drops: 2 });
  expect(host.dropped).toStrictEqual(['probe', 'spawn']);
  expect(host.countReactions()).toBe(6);
});
