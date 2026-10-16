import { expect, test } from 'bun:test';
import { toDaemonID, toSessionID } from '@atc/core';
import { DaemonError } from '@atc/protocol/wire';
import { StaleOwnershipError } from '@atc/store';
import { toDaemonError } from './to-daemon-error';

test('it answers a write refused for stale ownership with stale_epoch and the store message', () => {
  const stale = new StaleOwnershipError({
    sessionID: toSessionID('s-1'),
    ownerDaemonID: toDaemonID('d-other'),
    ownerEpoch: 2,
    writerDaemonID: toDaemonID('d-self'),
    writerEpoch: 1,
  });

  const converted = toDaemonError(stale);

  expect(converted).toBeInstanceOf(DaemonError);

  expect(converted).toMatchObject({
    code: 'stale_epoch',
    message:
      "session 's-1' is owned by daemon 'd-other' at epoch 2; this daemon writes as 'd-self' at epoch 1",
  });
});

test('it returns any other error unchanged', () => {
  const error = new Error('disk full');

  expect(toDaemonError(error)).toBe(error);
});
