import { DAEMON_ERROR_MAP } from '../daemon-contract/daemon-error-map';
import type { DaemonErrorMap } from '../daemon-contract/daemon-error-map';
import type { ErrorCode } from '../light/error-codes';

type FleetErrorEntry = DaemonErrorMap['internal'];

type FleetErrorCode =
  | ErrorCode
  | 'insufficient_scope'
  | 'daemon_unavailable'
  | 'daemon_unauthorized'
  | 'too_many_streams';

// oxlint-disable-next-line typescript/no-empty-interface -- a declaration file names an interface where it spells out a type alias's every error code at each procedure
export interface FleetErrorMap extends Readonly<Record<FleetErrorCode, FleetErrorEntry>> {}

const ENTRY: FleetErrorEntry = DAEMON_ERROR_MAP.internal;

export const FLEET_ERROR_MAP: FleetErrorMap = {
  ...DAEMON_ERROR_MAP,
  insufficient_scope: ENTRY,
  daemon_unavailable: ENTRY,
  daemon_unauthorized: ENTRY,
  too_many_streams: ENTRY,
};
