import { faker } from '@faker-js/faker';
import type { ImpSessionRequest } from '../daemon/imp-port';

/**
 * The request that starts a process on an imp.
 */
type StartRequest = Extract<ImpSessionRequest, { readonly kind: 'start' }>;

/**
 * The request that attaches to a process already running on an imp.
 */
type AttachRequest = Extract<ImpSessionRequest, { readonly kind: 'attach' }>;

type AttachOverrides = Partial<AttachRequest> & { readonly kind: 'attach' };

/**
 * A request that starts `true` on an imp with an empty environment, or, for
 * an override of kind `attach`, one that attaches without waking the imp.
 * Either carries no resume point and no requirements, and an arbitrary imp
 * name, session name, and terminal size; a start's directory is arbitrary
 * too. Each override replaces the default of its field.
 */
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
