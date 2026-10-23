import { expect, test } from 'bun:test';
import { DaemonError } from '@atc/protocol/wire';
import { buildStubCredentialBroker } from '../testing/build-stub-credential-broker';
import { toAuthRefusal } from './to-auth-refusal';

test("it answers a broker's refusal as an unavailable host that names the broker", async () => {
  const broker = buildStubCredentialBroker();

  const refusal = await broker.readGrants('atc-missing').then(
    () => null,
    (error: unknown) => error,
  );

  const answered = toAuthRefusal(refusal, broker);

  expect(answered).toBeInstanceOf(DaemonError);

  expect(answered).toMatchObject({
    code: 'host_unavailable',
    message: 'the stub-remote broker refused a runtime auth call: no host atc-missing',
    data: { provider: 'stub-remote', problem: 'not_found' },
  });
});

test("it ends an outdated broker's refusal with the upgrade step the broker gives", async () => {
  const broker = {
    ...buildStubCredentialBroker(),
    describe: { name: 'harbor', upgrade: 'upgrade harbord to 4.0.0 or later' },
  };

  broker.setOutdated(true);

  const refusal = await broker.verifyVersion().then(
    () => null,
    (error: unknown) => error,
  );

  expect(toAuthRefusal(refusal, broker)).toMatchObject({
    code: 'host_unavailable',
    message:
      'the harbor broker refused a runtime auth call: the broker is older than the oldest this atc supports; upgrade harbord to 4.0.0 or later',
    data: { provider: 'stub-remote', problem: 'outdated' },
  });
});

test("it answers an outdated broker's refusal alone for a broker that gives no upgrade step", async () => {
  const broker = buildStubCredentialBroker();

  broker.setOutdated(true);

  const refusal = await broker.verifyVersion().then(
    () => null,
    (error: unknown) => error,
  );

  expect(toAuthRefusal(refusal, broker)).toMatchObject({
    code: 'host_unavailable',
    message:
      'the stub-remote broker refused a runtime auth call: the broker is older than the oldest this atc supports',
  });
});

test('it gives the upgrade step to no other refusal of a broker', async () => {
  const broker = {
    ...buildStubCredentialBroker(),
    describe: { name: 'harbor', upgrade: 'upgrade harbord to 4.0.0 or later' },
  };

  const refusal = await broker.readGrants('atc-missing').then(
    () => null,
    (error: unknown) => error,
  );

  expect(toAuthRefusal(refusal, broker)).toMatchObject({
    message: 'the harbor broker refused a runtime auth call: no host atc-missing',
  });
});

test('it passes a daemon error through unchanged', () => {
  const error = new DaemonError('auth_blocked', 'the runtime auth of host s-1 is failed');

  expect(toAuthRefusal(error, buildStubCredentialBroker())).toBe(error);
});
