import { faker } from '@faker-js/faker';
import type { ImpIdentity } from '../daemon/imp-port';

/**
 * An impd token identity with an arbitrary name that manages the imps
 * matching `atc-*` and may grant no secret. An override replaces the field
 * it names.
 */
export function buildMockImpIdentity(overrides: Partial<ImpIdentity> = {}): ImpIdentity {
  return {
    kind: 'token',
    name: faker.word.noun(),
    scope: 'manage',
    imps: ['atc-*'],
    grantable: [],
    ...overrides,
  };
}
