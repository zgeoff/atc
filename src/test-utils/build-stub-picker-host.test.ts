import { expect, test } from 'bun:test';
import { buildStubPickerHost } from './build-stub-picker-host';

test('it records no reaction before the picker reacts', () => {
  const host = buildStubPickerHost();

  expect({
    counts: host.counts,
    dropped: host.dropped,
    reactions: host.countReactions(),
  }).toStrictEqual({
    counts: { renders: 0, exits: 0, attached: 0, drops: 0 },
    dropped: [],
    reactions: 0,
  });
});

test('it counts each reaction and keeps the kind of each dropped answer in order', async () => {
  const host = buildStubPickerHost();

  host.scheduleStatus();
  host.scheduleStatus();
  host.toBase();

  await host.attach();

  host.onDropAnswer('probe');
  host.onDropAnswer('spawn');

  expect({
    counts: host.counts,
    dropped: host.dropped,
    reactions: host.countReactions(),
  }).toStrictEqual({
    counts: { renders: 2, exits: 1, attached: 1, drops: 2 },
    dropped: ['probe', 'spawn'],
    reactions: 6,
  });
});
