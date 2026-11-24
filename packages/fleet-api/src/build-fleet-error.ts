import { FLEET_ERROR_MAP } from '@atcx/contract';
import { ORPCError } from '@orpc/server';

interface FleetErrorOptions {
  readonly message: string;
  readonly data?: unknown;
  readonly cause?: unknown;
}

// An oRPC error of a code. A code in the fleet error map is a defined error, so an oRPC client
// reads it as one the procedure declares; any other code keeps itself as an undefined error.
export function buildFleetError(
  code: string,
  options: FleetErrorOptions,
): ORPCError<string, unknown> {
  return new ORPCError(code, {
    defined: Object.hasOwn(FLEET_ERROR_MAP, code),
    message: options.message,
    data: options.data,
    cause: options.cause,
  });
}
