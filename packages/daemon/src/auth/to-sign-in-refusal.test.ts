import { expect, mock, test } from 'bun:test';
import { DaemonError } from '@atc/protocol/wire';
import { buildStubCredentialBroker } from '../testing/build-stub-credential-broker';
import { toSignInRefusal } from './to-sign-in-refusal';

test("it ends a Codex sign-in refusal with the broker's step to renew the secret", () => {
  const renewSecret = mock(() => 'run harbor put codex-chatgpt --kind oauth');
  const broker = { ...buildStubCredentialBroker(), describe: { name: 'harbor', renewSecret } };

  const refusal = new DaemonError(
    'auth_signin_needed',
    "agent 'codex' signs in through codex-chatgpt, whose sign-in in the broker is needs_login; sign Codex in again and give the broker the new refresh token for codex-chatgpt",
    { agent: 'codex', secret: 'codex-chatgpt', status: 'needs_login' },
  );

  const answered = toSignInRefusal(refusal, broker, [
    {
      secret: 'codex-chatgpt',
      kind: 'oauth',
      rules: [{ host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' }],
    },
  ]);

  expect(answered).toBeInstanceOf(DaemonError);

  expect(answered).toMatchObject({
    code: 'auth_signin_needed',
    message:
      "agent 'codex' signs in through codex-chatgpt, whose sign-in in the broker is needs_login; sign Codex in again and give the broker the new refresh token for codex-chatgpt; run harbor put codex-chatgpt --kind oauth",
    data: { agent: 'codex', secret: 'codex-chatgpt', status: 'needs_login' },
  });

  expect(renewSecret).toHaveBeenCalledExactlyOnceWith('codex-chatgpt', 'oauth');
});

test('it keeps the neutral sign-in refusal alone for a broker that gives no renew step', () => {
  const refusal = new DaemonError(
    'auth_signin_needed',
    "agent 'codex' signs in through codex-chatgpt, whose sign-in in the broker is pending; sign Codex in again and give the broker the new refresh token for codex-chatgpt",
    { agent: 'codex', secret: 'codex-chatgpt', status: 'pending' },
  );

  const answered = toSignInRefusal(refusal, buildStubCredentialBroker(), [
    {
      secret: 'codex-chatgpt',
      kind: 'oauth',
      rules: [{ host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' }],
    },
  ]);

  expect(answered).toBe(refusal);
});

test('it keeps a sign-in refusal alone when the binding holds no secret of its name', () => {
  const renewSecret = mock(() => 'run harbor put codex-chatgpt --kind oauth');
  const broker = { ...buildStubCredentialBroker(), describe: { name: 'harbor', renewSecret } };

  const refusal = new DaemonError(
    'auth_signin_needed',
    "agent 'codex' signs in through the oauth secret, whose sign-in in the broker is not listed; sign Codex in again and give the broker the new refresh token for the oauth secret",
    { agent: 'codex', secret: null, status: null },
  );

  expect(toSignInRefusal(refusal, broker, [])).toBe(refusal);
});

test('it passes any other refusal through unchanged', () => {
  const renewSecret = mock(() => 'run harbor put codex-chatgpt --kind oauth');
  const broker = { ...buildStubCredentialBroker(), describe: { name: 'harbor', renewSecret } };

  const refusal = new DaemonError('auth_blocked', 'the runtime auth of host s-1 is failed', {
    secret: 'codex-chatgpt',
  });

  expect(
    toSignInRefusal(refusal, broker, [
      {
        secret: 'codex-chatgpt',
        kind: 'oauth',
        rules: [{ host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' }],
      },
    ]),
  ).toBe(refusal);
});
