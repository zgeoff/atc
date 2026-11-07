import { expect, test } from 'bun:test';
import { buildMockNewPasskey } from './build-mock-new-passkey';

test('it builds a default new passkey with no use counted', () => {
  expect(buildMockNewPasskey()).toStrictEqual({
    tokenHash: expect.toBeString(),
    id: expect.toBeString(),
    publicKey: 'AQID',
    counter: 0,
    transports: ['internal'],
    now: expect.toBeNumber(),
  });
});

test('it applies overrides on top of the defaults', () => {
  expect(buildMockNewPasskey({ id: 'cred-phone', transports: ['usb'], now: 1000 })).toStrictEqual({
    tokenHash: expect.toBeString(),
    id: 'cred-phone',
    publicKey: 'AQID',
    counter: 0,
    transports: ['usb'],
    now: 1000,
  });
});
