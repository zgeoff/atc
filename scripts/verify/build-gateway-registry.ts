import { gatewayDaemonName } from './constants.ts';

// The gateway checks the daemon ID when it connects.
export function buildGatewayRegistry(listenPort: number, daemonID: string) {
  return {
    daemons: { [gatewayDaemonName]: { address: `127.0.0.1:${String(listenPort)}`, daemonID } },
    defaultDaemon: gatewayDaemonName,
  };
}
