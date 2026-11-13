// atc's own tables in the authorization database, and the one column of the
// package's client table that names a subscription's client. atc only reads
// the client table: @zgeoff/mcp-auth writes it.
export interface EventSchema {
  readonly oauthClient: { readonly clientId: string; readonly name: string | null };

  // Each MCP Events webhook subscription, under the id derived from its
  // client, callback URL, event name and canonical JSON arguments.
  readonly atc_event_subscription: {
    readonly id: string;
    readonly client_id: string;
    readonly url: string;
    readonly name: string;
    readonly arguments: string;

    // The whsec_ value the client sent.
    readonly secret: string;

    // The event trail cursor that its deliveries have reached.
    readonly position: string;
    readonly refresh_before: string;
    readonly created_at: string;
  };

  // When each client's callback URL last echoed a verification challenge.
  readonly atc_event_callback: {
    readonly client_id: string;
    readonly url: string;
    readonly verified_at: string;
  };
}
