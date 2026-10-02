// The slice of the daemon client the tool handlers need.
export interface FleetCaller {
  readonly sendRequest: (
    m: string,
    p?: Readonly<Record<string, unknown>>,
  ) => Promise<Readonly<Record<string, unknown>>>;
}

export interface ToolContext {
  readonly callerSessionID: string | null;

  // Who a sent message is from. A `fixed` sender is always used; a `default`
  // one gives way to a sender the tool call gives.
  readonly sender: { readonly kind: 'fixed' | 'default'; readonly name: string };
}
