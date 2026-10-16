import { expect, mock, test } from 'bun:test';
import { toSessionID } from '@atc/core';
import { PROTOCOL_V } from '@atc/protocol/wire';
import type { TapClient } from './daemon-context';
import { emitInboxClosed } from './emit-inbox-closed';

test('it tells the tap why its inbox closed', () => {
  const tap = { sendEvent: mock<TapClient['sendEvent']>() };

  emitInboxClosed(tap, toSessionID('s-1'), 'removed');

  expect(tap.sendEvent).toHaveBeenCalledExactlyOnceWith({
    v: PROTOCOL_V,
    ev: 'InboxClosed',
    s: toSessionID('s-1'),
    reason: 'removed',
  });
});

test('it tells nobody when the session had no tap', () => {
  expect(() => {
    emitInboxClosed(null, toSessionID('s-1'), 'replaced');
  }).not.toThrow();
});
