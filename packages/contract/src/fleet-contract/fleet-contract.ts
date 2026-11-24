import { buildFleetContract } from './build-fleet-contract';
import { DAEMON_SHAPES } from './daemon-shapes';
import { GATEWAY_SHAPES } from './gateway-shapes';

// the gateway's contract, which /rpc serves
export const FLEET_CONTRACT = buildFleetContract(GATEWAY_SHAPES);

// one daemon's contract, which `atc mcp` serves
export const LOCAL_FLEET_CONTRACT = buildFleetContract(DAEMON_SHAPES);
