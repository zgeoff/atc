export { AtcError } from '@atcx/contract/light';
export type { ErrorCode } from '@atcx/contract/light';

export type {
  DaemonEvent,
  DaemonFeature,
  DaemonProcedures,
  HelloResult,
  SessionID,
} from '@atcx/contract';

export { connect } from './connect';
export type { AtcClient, ConnectOptions } from './connect';
export { readDaemonSocketPaths } from './read-daemon-socket-paths';
