import { resolvePaths } from './resolve-paths';

// The paths of the environment this process started in.
const paths = resolvePaths(process.env);

export const configFile = paths.configFile;
export const stateDir = paths.stateDir;
export const socketPath = paths.socketPath;
export const daemonSocketPath = paths.daemonSocketPath;
export const eventsSocketPath = paths.eventsSocketPath;
export const statusFile = paths.statusFile;
export const dbFile = paths.dbFile;
export const mcpAuthDBFile = paths.mcpAuthDBFile;
export const legacyFleetFile = paths.legacyFleetFile;
export const daemonPidFile = paths.daemonPidFile;
export const daemonRecordFile = paths.daemonRecordFile;
export const restartsDir = paths.restartsDir;
export const restartLockFile = paths.restartLockFile;
