// The slice of the daemon client the tool handlers need.
export interface FleetCaller {
  readonly sendRequest: (
    m: string,
    p?: Readonly<Record<string, unknown>>,
  ) => Promise<Readonly<Record<string, unknown>>>;
}

export interface ToolContext {
  readonly callerSessionID: string | null;
  readonly defaultFrom: string;
}
