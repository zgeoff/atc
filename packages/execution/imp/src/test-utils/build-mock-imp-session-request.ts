import { faker } from '@faker-js/faker';
import type { ImpSessionRequest } from '../imp-port';

type StartRequest = Extract<ImpSessionRequest, { readonly kind: 'start' }>;

type AttachRequest = Extract<ImpSessionRequest, { readonly kind: 'attach' }>;

type AttachOverrides = Partial<AttachRequest> & { readonly kind: 'attach' };

export function buildMockImpSessionRequest(overrides?: Partial<StartRequest>): StartRequest;
export function buildMockImpSessionRequest(overrides: AttachOverrides): AttachRequest;

export function buildMockImpSessionRequest(
  overrides: Partial<StartRequest> | AttachOverrides = {},
): ImpSessionRequest {
  const name = `imp-${faker.string.alpha({ length: 6, casing: 'lower' })}`;
  const session = faker.string.uuid();
  const cols = faker.number.int({ min: 20, max: 300 });
  const rows = faker.number.int({ min: 5, max: 100 });

  return isAttachOverrides(overrides)
    ? { name, session, cols, rows, wake: false, ...overrides }
    : {
        kind: 'start',
        name,
        session,
        argv: ['true'],
        env: {},
        cwd: faker.system.directoryPath(),
        cols,
        rows,
        ...overrides,
      };
}

function isAttachOverrides(
  overrides: Partial<StartRequest> | AttachOverrides,
): overrides is AttachOverrides {
  return overrides.kind === 'attach';
}
