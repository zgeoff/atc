// A row of the primary daemon's stored fleet, as fleet.list answers it.
export interface FleetRow {
  readonly sessionID: string;

  // the daemon wrote the row while its session had no terminal, as a kill does
  readonly exited: boolean;
}
