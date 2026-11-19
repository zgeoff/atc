# Remote targets: the contract

- **Status:** draft

The provider contract changes in four places so that a remote host without impd's forward or broker
fits it: a `relay` capability with one shared relay over a byte stream, a tagged union for the
host's credentials, a read of what became of each sleeping harness, and a state folder for each
execution provider entry. imp and `local-pty` keep their behaviour. [The README](./README.md) holds
the decisions that span the parts.

The relay delivers every line exactly once while the daemon runs and the guest's mux lives. A daemon
restart can repeat one frame and lose the unacked tail of a connection that was open at the time, as
[the reset rule](#constraints) says.

## Shape

A link drops, and the daemon reattaches it:

```mermaid
sequenceDiagram
  participant R as reporter (guest)
  participant M as atc relay-mux (guest)
  participant D as openStreamRelay (daemon)
  R->>M: connect, write a hook line
  M->>D: open seq 1, line seq 2
  Note over M,D: the link drops; M keeps seq 1 and 2
  D->>M: newline, hello {link, gen 2, ack 0}
  M->>D: replay from byte 0, then welcome {link, gen 2, ack 0}
  Note over D: discards every byte before its own welcome
  M->>D: open seq 1, line seq 2 again
  D->>M: ack 2
```

## Contracts

### The relay

A provider whose host offers a byte stream that survives a drop calls `openStreamRelay` in
`spawnHarness`, and passes the daemon's `onRelay` through.

```ts
const relay = openStreamRelay(
  openSpriteRelayLink(api, sprite, { argv: [guest.atc, 'relay-mux', socket] }),
  spec.onRelay,
  { reconnectDelaysMs: [250, 1000, 5000], log },
);

await relay.listening; // the guest listens on `socket`; the harness may start
// → resolves, or rejects when the host lost the mux before it listened
```

```ts
// plugin-api. A provider supplies only the link.
interface RelayLink {
  // starts the guest's `atc relay-mux <socket>`, or attaches the one the host still runs for this link
  open(): Promise<RelayLinkConnection>;
}

interface RelayLinkConnection {
  onData(listener: (data: Uint8Array) => void): void; // may replay stdout from any earlier byte, byte 0 included
  onEnd(listener: (end: 'dropped' | 'lost') => void): void; // lost: the host no longer holds the mux
  write(data: Uint8Array): Promise<void>;
  detach(): void; // lets go and leaves the mux running
}

declare function openStreamRelay(
  link: RelayLink,
  onRelay: (relay: HarnessRelay) => void,
  options: StreamRelayOptions,
): OpenedRelay;

interface OpenedRelay {
  readonly listening: Promise<void>;
  stop(): void; // closes every connection the daemon holds and detaches the link
}

interface StreamRelayOptions {
  readonly reconnectDelaysMs: readonly number[]; // after the last one, every retry waits the last delay
  readonly log?: (line: string) => void;
}
```

The frames are one JSON object per line, in a light entry that the guest's `atc relay-mux` loads
without Zod or the protocol contract. `seq` counts the frames each side sends, and a receiver
applies only the frame one past the last it applied.

```ts
// protocol, entry `@atc/protocol/relay`
type DaemonFrame =
  | { t: 'hello'; link: string; gen: number; ack: number } // link: new per openStreamRelay call; gen: new per open
  | { t: 'line'; seq: number; conn: number; line: string }
  | { t: 'close'; seq: number; conn: number }
  | { t: 'ack'; ack: number }; // the highest guest seq the daemon applied

type GuestFrame =
  | { t: 'welcome'; link: string; gen: number; ack: number; reset: boolean } // echoes the hello; reset: a new link, numbering from 1
  | { t: 'open'; seq: number; conn: number } // a reporter connected to the socket
  | { t: 'line'; seq: number; conn: number; line: string }
  | { t: 'end'; seq: number; conn: number } // the reporter wrote its last line
  | { t: 'close'; seq: number; conn: number }
  | { t: 'ack'; ack: number };
```

```ts
// plugin-api
interface ExecutionCapabilities {
  // …existing fields
  readonly relay: boolean; // carries HarnessSpec.onRelay; imp true through its forward, local-pty false
}

interface HostRequest {
  // …existing fields
  readonly isNew?: boolean; // the spawn of a top-level session, whose host must not exist yet
}
```

### Credentials

```ts
// daemon, auth. Pure.
const decision = decideHarnessAuth(
  adapter.findAuthSelection?.() ?? null,
  provider.credentials ?? { kind: 'none' },
  adapter.findCredentialOverrides?.() ?? [],
);
// → { kind: 'routed', router }
//   or { kind: 'refused', problem: 'route_required' }
```

```ts
// plugin-api
interface ExecutionProvider {
  // …existing fields, without brokerAuth and rebindChangedAuth
  readonly credentials?: HostCredentials; // absent is { kind: 'none' }
}

type HostCredentials =
  | { kind: 'none' } // the host's own sign-in: an agent with optional auth runs under it, as today
  | { kind: 'broker'; broker: CredentialBroker; rebindChangedAuth: boolean } // imp, today's path moved here
  | { kind: 'routed'; router: CredentialRouter } // Sprites: every agent must sign in through a route
  | { kind: 'host-sign-in' }; // Docker: the user's own token, which no agent with auth runs under

interface CredentialRouter {
  readonly hostPrefix: string; // the start of every host name; the router's access policy admits it
  readonly describe: { readonly name: string; readonly upgrade?: string };
  // rejects unless every profile has a route that admits hostPrefix
  verifyRoutes(profiles: readonly AuthProfile[]): Promise<void>;
  // the URL each profile's requests go to, keyed by profile name; the router adds the credential
  readRoutes(profiles: readonly AuthProfile[]): Promise<Readonly<Record<string, string>>>;
}

// daemon, auth
type HarnessAuthDecision =
  | { kind: 'none' } // the launch takes no credential from atc
  | {
      kind: 'refused';
      problem:
        | 'broker_required'
        | 'route_required'
        | 'credential_override'
        | 'auth_on_sign_in_host'
        | 'sign_in_unsupported';
    }
  | { kind: 'broker'; broker: CredentialBroker } // the caller still refuses when the daemon holds no auth binder, as today
  | { kind: 'routed'; router: CredentialRouter };

declare function decideHarnessAuth(
  selection: AuthSelection | null,
  credentials: HostCredentials,
  overrides: readonly string[],
): HarnessAuthDecision;
```

```ts
// plugin-api, agent-adapter
interface AgentAdapter {
  // …existing fields
  // the credential and endpoint variables the agent's own config sets: its env, its settings' env,
  // and settings passed in its args. Absent finds none.
  readonly findCredentialOverrides?: () => readonly string[];
  // the file in a host-sign-in volume this agent reads its token from. Absent: refused on host-sign-in.
  readonly signInFile?: string; // Claude: 'claude-oauth-token'
}

interface GuestPaths {
  // …existing fields
  readonly auth?: {
    // …existing fields
    readonly routes?: Readonly<Record<string, string>>; // per profile name; the adapter points its endpoint variable at it
  };
  readonly signIn?: { readonly directory: string }; // where a host-sign-in volume mounts in the host
}
```

### What became of a sleeping harness

```ts
const fates = await provider.readHarnessFates?.('k3f9', ['s-1', 's-2']);
// → Map { 's-1' => 'kept', 's-2' => 'lost' }
```

```ts
// plugin-api
interface ExecutionProvider {
  // …existing fields
  // read without waking the host; a session the answer leaves out is 'unknown'
  readonly readHarnessFates?: (
    host: string,
    sessions: readonly string[],
  ) => Promise<ReadonlyMap<string, HarnessFate>>;
}

type HarnessFate = 'kept' | 'lost' | 'unknown'; // lost: the host no longer holds the process, such as after a cold boot

// plugin-api, plugin. Passed to an execution plugin's create in place of HostServices.
interface ExecutionHostServices extends HostServices {
  readonly stateDir: string; // <state>/providers/<entry id>/, which this entry alone writes; kept across restarts
}
```

`spawnHarness` keeps its signature. On a remote host it attaches the harness that the host still
runs for `spec.session`, and otherwise starts the spec's argv, which a revive plans as the resume
command. `waitForStart` reports which through `created`.

## Constraints

- A remote spawn on a provider whose `relay` capability is false is refused with
  `unsupported_operation`, problem `no_session_bridge`.
- While the daemon runs and the guest's mux lives, every frame arrives exactly once and in order,
  both ways, across any number of dropped links.
- The daemon discards every byte before the welcome that echoes its own link and gen, so a replay of
  stdout from byte 0 never reaches the bridge twice.
- The daemon writes a newline before each hello, which ends any half line that a cut-off write left
  in the guest's stdin.
- No welcome within 10 seconds counts as a drop.
- A link that ends `lost` closes every bridge connection it carried and stops; the harness's own
  exit says why.
- A new link, after a daemon restart or a kill and an adopt, resets the guest's numbering. Across
  that reset only:
  - a frame the old link applied but had not acked arrives once more;
  - the unacked tail of a connection whose `open` the old link acked is dropped, and the guest
    closes that connection. Notes come back from the outbox and the tap reconnects; a hook line in
    that tail is lost.
- The mux never closes a connection unread. With 1 MiB of unacked frames held, it stops accepting
  new connections until acks free room, and a reporter that waits past its own timeout loses its
  line.
- The daemon holds at most 1 MiB of unacked frames per link, and `writeLine` settles only once its
  frame fits.
- The mux exits only when the provider stops it or its host ends it. It never exits when its stdin
  closes.
- Every bridge connection stays open on both sides while a link is down, so the bridge sees only
  lines that arrive late.
- Every credentials refusal is `auth_target_unsupported` with the problem from `decideHarnessAuth`.
  `decideHarnessAuth` refuses:
  - on `none`, an agent whose auth requires the broker, with `broker_required`;
  - on `routed`, an agent with no auth selection, with `route_required`, so no Sprites session signs
    in on the host;
  - on `routed`, an agent whose `findCredentialOverrides` finds any variable, with
    `credential_override`;
  - on `host-sign-in`, an agent with an auth selection, with `auth_on_sign_in_host`;
  - on `host-sign-in`, an agent with no `signInFile`, with `sign_in_unsupported`.
- A routed launch builds the placeholder env and the profile env from the selection as a broker
  launch does, records no binding, takes no admission, runs at revision 1, and sets no `oauth` or
  `telemetryHost`. Revoke and rebind on a routed host refuse with `unsupported_operation`, problem
  `routed_auth`.
- `verifyRoutes` runs before anything touches the host, so a refused launch creates no host.
- The daemon's agent list and target list filter each target through `decideHarnessAuth` with no
  overrides, so a target never lists an agent it would refuse for its selection. The wire keeps
  `brokerAuth` as `credentials` of kind `broker` or `routed`, so `@atcx/contract` changes only the
  field's comment.
- A host-sign-in launch never puts the token in the harness's environment as the host stores it. The
  adapter's launch reads `<signIn.directory>/<signInFile>` inside the host when the harness starts.
- A `prepareHost` with `isNew` refuses with `host_unavailable`, problem `host_exists`, when the host
  already exists, so a spawn never reuses another session's host.
- On restore, the daemon reads the fates of every host that has sleeping sessions, in the
  background, so a slow host never delays the restore. Each time the daemon readies a host, it reads
  the fates of the other sleeping sessions on that host.
- A `lost` session lists as exited with the message of `HARNESS_EXIT_TRANSITIONS.ended`, and the
  fleet row is not rewritten, because the owner never asked for the loss.
- A fate read that fails changes nothing: the sessions stay asleep, and the next revive finds out.
- `stateDir` is not one of the published state paths, and the daemon creates it before it calls
  `create`.
- imp declares `relay: true`, `credentials: { kind: 'broker', … }`, and no `readHarnessFates`, and
  otherwise behaves as today. `local-pty` declares `relay: false`.

## Builder decides

- The names and files of internal helpers, the mux's spool layout, and how acks batch.
- The exact reconnect delays, within the 10-second welcome limit.
- The wording of each refusal.
- Whether `openStreamRelay` lives in `@atc/plugin-api` or a package of its own that plugin-api
  re-exports, within the zones in `.oxlintrc.zones.json`.
- How the routed launch is tested before a Sprites provider exists: a stub router and a stub
  provider are enough.
