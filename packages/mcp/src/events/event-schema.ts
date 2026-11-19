// @zgeoff/mcp-auth owns and writes the client table; atc only reads the one column of it
// that names a subscription's client.
export interface EventSchema {
  readonly oauthClient: { readonly clientId: string; readonly name: string | null };

  // The id is derived from the client, callback URL, event name and canonical JSON arguments.
  readonly atc_event_subscription: {
    readonly id: string;
    readonly client_id: string;
    readonly url: string;
    readonly name: string;
    readonly arguments: string;

    // The whsec_ value the client sent.
    readonly secret: string;

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
