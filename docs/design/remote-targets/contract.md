# Remote targets: the contract

- **Status:** agreed

The execution provider contract changes so that a host without impd fits it.
[The README](./README.md#terms) defines the terms this doc uses, impd's forward and broker among
them.

- **The relay.** A provider whose host offers a byte stream to a process inside it, such as a
  sprite's exec or a container's attach, carries the session bridge over that stream with
  `openStreamRelay`.
- **The credentials kind.** A provider declares how its host supplies credentials, and the daemon
  decides each launch from that declaration.
- **Harness fates.** A provider can say, without waking a host, whether the host still holds each
  sleeping session's harness.
- **The state folder.** Each execution provider entry gets a folder of its own on the daemon's
  machine.

imp declares `relay: true` and carries the session bridge through impd's forward, with no
`openStreamRelay`. It declares the broker kind. `local-pty` declares `relay: false` and no
credentials.

## A dropped connection, reopened

`openStreamRelay` opens a connection to the guest's `atc relay-mux` through the provider's
`RelayLink`. The mux holds every frame until the daemon acks it, so a dropped connection loses
nothing:

```mermaid
sequenceDiagram
  participant R as reporter (guest)
  participant M as atc relay-mux (guest)
  participant D as openStreamRelay (daemon)
  R->>M: connect, write a hook line
  M->>D: open seq 1, line seq 2
  Note over M,D: the connection drops; M keeps seq 1 and 2
  D->>M: newline, hello {v 1, relay, gen 2, ack 0}
  M->>D: stdout replayed from byte 0, then welcome {v 1, relay, gen 2, ack 0}
  Note over D: discards every byte before its own welcome
  M->>D: open seq 1, line seq 2, again
  D->>M: ack 2
```

## Contracts

### The relay

A provider calls `openStreamRelay` in `spawnHarness` and passes the daemon's `onRelay` through. The
provider supplies only a `RelayLink`, which opens a connection to the guest's `atc relay-mux`. The
mux binds the bridge socket before it reads stdin, so its first welcome means reporters can connect.

```ts
const relay = openStreamRelay(
  openSpriteRelayLink(api, sprite, { argv: [guest.atc, 'relay-mux', socket] }),
  spec.onRelay,
  { reconnectDelaysMs: [250, 1000, 5000], log },
);

await relay.listening; // resolves on the first welcome
// → the harness may start; rejects when the host lost the mux before its first welcome
```

```ts
// plugin-api
interface RelayLink {
  // starts the guest's `atc relay-mux <socket>`, or attaches to the one the host still runs for this link.
  // replace: true stops that mux first and starts a new one.
  open(options?: { readonly replace?: boolean }): Promise<RelayLinkConnection>;
}

interface RelayLinkConnection {
  onData(listener: (data: Uint8Array) => void): void; // the mux's stdout; may replay from any earlier byte, byte 0 included
  onEnd(listener: (end: 'dropped' | 'lost') => void): void; // lost: the host no longer runs the mux
  write(data: Uint8Array): Promise<void>; // the mux's stdin
  detach(): void; // lets go of the connection and leaves the mux running
}

declare function openStreamRelay(
  link: RelayLink,
  onRelay: (relay: HarnessRelay) => void,
  options: StreamRelayOptions,
): OpenedRelay;

interface OpenedRelay {
  readonly listening: Promise<void>;
  stop(): void; // closes every bridge connection this relay carries, and detaches its connection
}

interface StreamRelayOptions {
  readonly reconnectDelaysMs: readonly number[]; // after the last delay, every retry waits the last delay, until stop()
  readonly log?: (line: string) => void;
}

interface ExecutionCapabilities {
  // …existing fields
  readonly relay: boolean; // the provider carries HarnessSpec.onRelay
}
```

The frames are one JSON object per line. They live in the package entry `@atc/protocol/relay`, which
loads neither Zod nor the protocol contract, so the mux starts fast. Each side numbers the frames it
sends in `seq`, and applies only the frame one past the last it applied.

```ts
// protocol, entry `@atc/protocol/relay`
type DaemonFrame =
  | { t: 'hello'; v: 1; relay: string; gen: number; ack: number } // relay: new per openStreamRelay call; gen: new per connection
  | { t: 'line'; seq: number; conn: number; line: string } // a line the daemon writes to a reporter
  | { t: 'close'; seq: number; conn: number } // the daemon closed its side of the bridge connection
  | { t: 'ack'; ack: number }; // the highest guest seq the daemon applied

type GuestFrame =
  | { t: 'welcome'; v: 1; relay: string; gen: number; ack: number; reset: boolean } // echoes the hello's relay and gen
  | { t: 'open'; seq: number; conn: number } // a reporter connected to the socket
  | { t: 'line'; seq: number; conn: number; line: string }
  | { t: 'end'; seq: number; conn: number } // the reporter closed its write side; it may still read
  | { t: 'close'; seq: number; conn: number } // the reporter's socket closed
  | { t: 'ack'; ack: number };
```

### Credentials

The daemon decides a launch's credentials from the target's declaration, the agent's auth selection,
and any credential setting in the agent's own config. For a Sprites launch whose agent has no auth
selection:

```ts
// daemon, auth. Pure.
const conflict =
  credentials.kind === 'none' ? null : (adapter.findGuestEnvConflict?.(credentials.kind) ?? null);
const decision = decideHarnessAuth(adapter.findAuthSelection?.() ?? null, credentials, conflict);
// → { kind: 'refused', problem: 'route_required' }
//   and with a selection: { kind: 'routed', router }
```

```ts
// plugin-api
interface ExecutionProvider {
  // …existing fields; the brokerAuth and rebindChangedAuth fields move into credentials
  readonly credentials?: HostCredentials; // absent is { kind: 'none' }
}

type HostCredentials =
  | { kind: 'none' } // atc supplies no credential; an agent signs in on the host by itself
  | { kind: 'broker'; broker: CredentialBroker; rebindChangedAuth: boolean } // imp
  | { kind: 'routed'; router: CredentialRouter } // Sprites: a service outside the host adds the credential
  | { kind: 'stored-token' }; // Docker: a token the user stored once, mounted into every container

interface CredentialRouter {
  readonly hostPrefix: string; // the start of every host name; the Sprites provider passes its spritePrefix
  // rejects unless every profile has a route whose access policy admits every name that starts with
  // hostPrefix; runs before anything touches the host
  verifyRoutes(profiles: readonly AuthProfile[]): Promise<void>;
  // the URL that each profile's requests go to, keyed by profile name; the router adds the credential there
  readRoutes(profiles: readonly AuthProfile[]): Promise<Readonly<Record<string, string>>>;
}

// daemon, auth
type HarnessAuthDecision =
  | { kind: 'none' } // the launch takes no credential from atc
  | {
      kind: 'refused';
      problem:
        | 'broker_required'
        | 'guest_env_conflict'
        | 'route_required'
        | 'auth_on_stored_token'
        | 'sign_in_unsupported';
    }
  | { kind: 'broker'; broker: CredentialBroker }
  | { kind: 'routed'; router: CredentialRouter }
  | { kind: 'stored-token' };

declare function decideHarnessAuth(
  selection: AuthSelection | null,
  credentials: HostCredentials,
  conflict: string | null,
): HarnessAuthDecision;
```

```ts
// plugin-api, agent-adapter
interface AgentAdapter {
  // …existing fields
  // The first key in the agent's own config that would replace the credentials of this kind, or send
  // the agent's requests around them. It looks in the agent's env, the env in its settings,
  // and settings passed in its args. A key is a credential or endpoint variable, or a
  // credential helper such as settings.apiKeyHelper. A gateway agent, whose config sets its own
  // baseURL, also returns 'baseURL' for routed and stored-token, because its requests would go to that
  // URL in place of the route or the token's API. Absent finds none.
  readonly findGuestEnvConflict?: (kind: 'broker' | 'routed' | 'stored-token') => string | null;
  // the file in the stored-token volume that this agent reads its token from. Absent: refused on stored-token.
  readonly signInFile?: string; // Claude: 'claude-oauth-token'
}

// plugin-api, agent-adapter. The daemon builds GuestPaths for the adapter from the provider's GuestLayout.
interface GuestPaths {
  // …existing fields
  readonly auth?: {
    // …existing fields
    // the route per profile name. Claude sets ANTHROPIC_BASE_URL to its profile's route, ANTHROPIC_AUTH_TOKEN
    // to the placeholder value of runtime auth, and no CLAUDE_CODE_OAUTH_TOKEN.
    readonly routes?: Readonly<Record<string, string>>;
  };
  readonly signIn?: { readonly directory: string }; // from GuestLayout.signIn
}

// plugin-api, execution-provider. The provider's readGuest returns it.
interface GuestLayout {
  // …existing fields
  readonly signIn: string | null; // the stored-token volume's mount in the host; null on every other kind
}
```

### Harness fates

```ts
const fates = await provider.readHarnessFates?.('k3f9', ['s-1', 's-2']);
// → Map { 's-1' => 'kept', 's-2' => 'lost' }
```

```ts
// plugin-api
interface ExecutionProvider {
  // …existing fields
  // read without waking the host; takes session ids, and a session the answer leaves out is 'unknown'
  readonly readHarnessFates?: (
    host: string,
    sessions: readonly string[],
  ) => Promise<ReadonlyMap<string, HarnessFate>>;
}

type HarnessFate = 'kept' | 'lost' | 'unknown'; // lost: the host no longer holds the session's harness, such as after a reboot
```

`spawnHarness` keeps its signature. On a remote host it attaches to the harness that the host still
runs for `spec.session`. When the host runs none, it starts `spec.argv`, which a revive sets to the
agent's resume command. `HarnessStart.created` is true when the provider started the harness, and
false when it attached to one.

### The state folder

```ts
// plugin-api, plugin. An execution plugin's create gets these in place of HostServices.
interface ExecutionHostServices extends HostServices {
  readonly stateDir: string; // <state>/providers/<entry id>/, mode 0700; only this entry writes it, and it lasts across restarts
}
```

## Constraints

### The relay

- The daemon refuses a remote spawn on a provider whose `relay` capability is false with
  `unsupported_operation`, problem `no_session_bridge`, before anything touches the host.
- While the daemon runs and the guest's mux lives, every frame arrives once and in order, both ways,
  across any number of dropped connections.
- The daemon discards every byte before the welcome that echoes its own `relay` and `gen`, so a
  replay of stdout from byte 0 never reaches the session bridge twice.
- The daemon writes a newline before each hello, which ends any half line that a cut-off write left
  in the guest's stdin.
- The daemon counts a connection as dropped when no welcome arrives within 10 seconds of its hello.
- When a welcome holds a `v` the daemon cannot speak, the daemon opens the link with
  `replace: true`. The new mux answers with `reset: true`.
- When a connection ends `lost`, `openStreamRelay` closes every bridge connection it carries and
  stops retrying. The harness's exit then reaches the daemon through `spawnHarness` as usual.
- A new `openStreamRelay` call, after a daemon restart or after a kill and a revive, brings a new
  `relay` id. The guest answers it with `reset: true`:
  - the guest closes every bridge connection it had open and drops their unacked frames, and both
    sides number their frames from 1 again;
  - a reporter's note comes back from its outbox, and the message tap reconnects. A hook line that
    was in flight is lost. [Messages](../../architecture/protocol/messages.md) covers the outbox and
    the tap.
- The mux closes a bridge connection only after the daemon acks its last frame. When the mux holds 1
  MiB of unacked frames, it accepts no new bridge connection until acks free room. A reporter that
  waits past its own timeout loses its line.
- The daemon holds at most 1 MiB of unacked frames per relay. `HarnessRelay.writeLine` settles only
  when its frame fits.
- The mux exits only when the provider stops it or its host ends it. It never exits when its stdin
  closes.
- While a connection is down, every bridge connection stays open on both sides, and the lines reach
  the session bridge late.

### Credentials

- `decideHarnessAuth` refuses with the first row that matches, and every refusal is
  `auth_target_unsupported` with the row's problem:

| Credentials kind | When                                           | Problem                |
| ---------------- | ---------------------------------------------- | ---------------------- |
| `none`           | the agent's auth selection requires the broker | `broker_required`      |
| `broker`         | `findGuestEnvConflict` found a key             | `guest_env_conflict`   |
| `routed`         | `findGuestEnvConflict` found a key             | `guest_env_conflict`   |
| `routed`         | the agent has no auth selection                | `route_required`       |
| `stored-token`   | `findGuestEnvConflict` found a key             | `guest_env_conflict`   |
| `stored-token`   | the agent has an auth selection                | `auth_on_stored_token` |
| `stored-token`   | the agent has no `signInFile`                  | `sign_in_unsupported`  |

- The Claude adapter's check for override variables on a broker launch becomes its
  `findGuestEnvConflict` for the `broker` kind, and refuses the same keys.
- When the decision is `broker` and the daemon holds no auth binder, the daemon refuses with
  `unsupported_operation`, problem `no_auth_binder`.
- A routed launch builds the placeholder variables and the profile variables from the selection, as
  a broker launch does. It records no broker binding, takes no admission, runs at revision 1, and
  sets no `oauth` or `telemetryHost`. [Runtime auth](../../architecture/execution/runtime-auth.md)
  defines these.
- The daemon refuses a revoke or a rebind on a routed host with `unsupported_operation`, problem
  `routed_auth`.
- The daemon calls `verifyRoutes` before anything touches the host, so a refused launch creates no
  host.
- A stored-token launch never sets the token in a container's or exec's environment. The adapter's
  launch reads `<signIn.directory>/<signInFile>` inside the host when the harness starts, and
  exports it to the harness process only.
- The daemon builds the agent list and the target list with the same check as a launch,
  `findGuestEnvConflict` included, so it never lists an agent on a target that would refuse the
  agent's default selection.
- On the wire, `brokerAuth` is true for the `broker` and `routed` kinds, because a client shows the
  agent's auth profiles for each target that sets it. The capabilities gain `relay`.
  `@atcx/contract` takes that one new field, and `bun run check:contract --update` records it.
- The daemon refuses a config in which one Sprites target's `spritePrefix` starts with another's,
  with the two target ids in the error. Otherwise a connector's policy that admits the shorter
  prefix would admit the other target's sprites too.

### Harness fates

- On restore, the daemon reads the harness fates of every host that has sleeping sessions, in the
  background, so a slow host never delays the restore.
- Each time the daemon readies a host, it reads the harness fates of the other sleeping sessions on
  that host.
- The daemon lists a `lost` session as exited, with the message of `HARNESS_EXIT_TRANSITIONS.ended`.
  It leaves the fleet row as it is, because the owner never asked for the loss, so each restore
  reads the fate again.
- A revive of a `lost` session takes the normal revive path, and `spawnHarness` starts the resume
  command.
- When a fate read fails, the daemon changes nothing: the sessions stay asleep, and the next revive
  finds out.

### The state folder

- The daemon creates `stateDir` before it calls the plugin's `create`. When a target leaves the
  config, its folder stays in place.
- `stateDir` is not one of the state paths that `@atcx/contract` publishes.

## Builder decides

- The names and files of internal helpers, the mux's spool layout, and how acks batch.
- The exact reconnect delays.
- The wording of each refusal.
- Whether `openStreamRelay` lives in `@atc/plugin-api` or in a package of its own that plugin-api
  re-exports, within the zones in `.oxlintrc.zones.json`.
- How to test the routed launch before a Sprites provider exists. A stub router and a stub provider
  are enough.
