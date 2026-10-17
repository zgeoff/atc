import { faker } from '@faker-js/faker';
import type { ImpIdentity } from '../imp-port';

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
