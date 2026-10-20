import { expect, test } from 'bun:test';
import { DaemonError } from '@atc/protocol/wire';
import { buildStubCredentialBroker } from '../testing/build-stub-credential-broker';
import { toAuthRefusal } from './to-auth-refusal';

test("it answers a broker's refusal as an unavailable host that names the broker's provider", async () => {
  const refusal = await buildStubCredentialBroker()
    .readGrants('atc-missing')
    .then(
      () => null,
      (error: unknown) => error,
    );

  const answered = toAuthRefusal(refusal);

  expect(answered).toBeInstanceOf(DaemonError);

  expect(answered).toMatchObject({
    code: 'host_unavailable',
    message: 'the stub-remote credential broker refused a runtime auth call: no host atc-missing',
    data: { provider: 'stub-remote', problem: 'not_found' },
  });
});

test('it passes a daemon error through unchanged', () => {
  const error = new DaemonError('auth_blocked', 'the runtime auth of host s-1 is failed');

  expect(toAuthRefusal(error)).toBe(error);
});
