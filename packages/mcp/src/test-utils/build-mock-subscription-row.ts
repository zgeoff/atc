import type { MockOverrides } from '@atc/test-utils';
import { faker } from '@faker-js/faker';
import { mergeDeep } from '@zgeoff/std';
import type { SubscriptionRow } from '../events/create-subscription-store';

export function buildMockSubscriptionRow(
  overrides: MockOverrides<SubscriptionRow, keyof SubscriptionRow> = {},
): SubscriptionRow {
  const createdAt = faker.date.recent();

  return mergeDeep<SubscriptionRow>(
    {
      id: `sub_${faker.string.hexadecimal({ length: 32, prefix: '', casing: 'lower' })}`,
      client_id: faker.string.alphanumeric(32),
      url: faker.internet.url(),
      name: 'session.turn_done',
      arguments: '{}',
      secret: `whsec_${Buffer.from(faker.string.alphanumeric(32)).toString('base64')}`,
      position: faker.string.alphanumeric(12),
      refresh_before: new Date(createdAt.getTime() + 60 * 60 * 1000).toISOString(),
      created_at: createdAt.toISOString(),
    },
    overrides,
  );
}
