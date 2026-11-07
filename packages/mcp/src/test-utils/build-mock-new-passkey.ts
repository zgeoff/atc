import type { MockOverrides } from '@atc/test-utils';
import { faker } from '@faker-js/faker';
import { mergeDeep } from '@zgeoff/std';
import type { NewPasskey } from '../auth/create-passkey';

export function buildMockNewPasskey(
  overrides: MockOverrides<NewPasskey, keyof NewPasskey> = {},
): NewPasskey {
  return mergeDeep<NewPasskey>(
    {
      tokenHash: faker.string.hexadecimal({ length: 64, prefix: '' }),
      id: faker.string.alphanumeric(22),
      publicKey: 'AQID',
      counter: 0,
      transports: ['internal'],
      now: faker.date.recent().getTime(),
    },
    overrides,
  );
}
