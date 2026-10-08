import { expect, mock, test } from 'bun:test';
import type { LaunchTicket } from '../daemon/execution-provider';
import { DaemonError } from '../protocol/daemon-error';
import { buildStubLaunchAdmission } from './build-stub-launch-admission';

test('it hands send one ticket before the admission settles', () => {
  const stub = buildStubLaunchAdmission(() => null);
  const send = mock<(ticket: LaunchTicket) => void>();
  const admitted = stub.admit('start', send);

  expect(send).toHaveBeenCalledOnce();
  expect(Bun.peek.status(admitted)).toBe('fulfilled');
});

test('it gives the ticket the check it was built with', async () => {
  const refusal = new DaemonError('auth_blocked', 'the runtime auth is revoked');

  const stub = buildStubLaunchAdmission(() => refusal);
  const tickets: LaunchTicket[] = [];

  await stub.admit('attach', (ticket) => {
    tickets.push(ticket);
  });

  expect(tickets[0]?.check()).toBe(refusal);
});

test('it passes on the throw of a check that throws', async () => {
  const stub = buildStubLaunchAdmission(() => {
    throw new Error('the binder broke');
  });

  const tickets: LaunchTicket[] = [];

  await stub.admit('start', (ticket) => {
    tickets.push(ticket);
  });

  expect(() => tickets[0]?.check()).toThrowWithMessage(Error, 'the binder broke');
});
