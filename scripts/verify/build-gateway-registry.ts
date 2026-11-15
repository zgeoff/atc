import { gatewayDaemonName } from './constants.ts';

// The registry of a gateway of the run: the run's daemon, at the loopback port its TCP listener
// bound, and the daemon ID it printed, which the gateway checks when it connects.
export function buildGatewayRegistry(listenPort: number, daemonID: string) {
  return {
    daemons: { [gatewayDaemonName]: { address: `127.0.0.1:${String(listenPort)}`, daemonID } },
    defaultDaemon: gatewayDaemonName,
  };
}
