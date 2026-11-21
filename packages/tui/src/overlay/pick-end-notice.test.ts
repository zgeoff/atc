import { expect, test } from 'bun:test';
import { AtcError } from '@atcx/contract/light';
import { pickEndNotice } from './pick-end-notice';

test.each([
  {
    title: 'the pinned notice for a refusal of a pinned session',
    error: new AtcError('session_pinned', 'pinned'),
    expected: 'unpin orders first',
  },
  {
    title: 'the asleep notice for a host that is asleep',
    error: new AtcError('unsupported_operation', 'asleep', { problem: 'host_asleep' }),
    expected: "orders's machine is asleep: attach to wake it, then end it",
  },
  {
    title: 'null for another cause under the same code',
    error: new AtcError('unsupported_operation', 'no', { problem: 'ram_budget_exceeded' }),
    expected: null,
  },
  { title: 'null for an error that is no AtcError', error: new Error('boom'), expected: null },
])('#pickEndNotice gives $title', (row) => {
  expect(pickEndNotice(row.error, 'orders')).toBe(row.expected);
});
