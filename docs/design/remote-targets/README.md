# Remote targets: Sprites and Docker

- **Status:** draft
- **Decision records:** [0001](../../decisions/0001-sprites-credentials-through-connectors.md)

atc runs remote sessions only on imps today, and the provider contract has the shape of impd: a
reverse unix-socket forward carries hooks, a broker swaps credentials in flight, and a host sleeps
with its harnesses inside. Two new execution providers, `sprites` for Fly.io Sprites and `docker`
for the local Docker Engine, have neither the forward nor the broker. The contract gains one shared
relay over any byte stream that can drop and reattach, a tagged union for how a host supplies
credentials, and a way to learn that a sleeping host lost its harness. imp keeps its forward and its
broker.

## Shape

```mermaid
flowchart LR
  daemon[daemon] -->|"HarnessSpec.onRelay"| relay["openStreamRelay (plugin-api)"]
  relay -->|"RelayLink: non-TTY exec"| mux1["atc relay-mux in a sprite"]
  relay -->|"RelayLink: sidecar attach"| mux2["atc relay-mux in a container"]
  daemon -->|"onRelay, as today"| imp["imp provider: reverse forward"]
  daemon -->|"credentials kind"| auth["decideHarnessAuth"]
  auth --> broker["broker: impd"]
  auth --> routed["routed: Sprites connectors"]
  auth --> signin["host-sign-in: Docker volume"]
```

## The parts

| Doc                           | Owns                                                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [The contract](./contract.md) | the `relay` capability, `openStreamRelay` and its frames, `HostCredentials`, `readHarnessFates`, `stateDir` |
| [Sprites](./sprites.md)       | the `sprites` provider: its config, how each imp duty maps to a sprite, its gaps                            |
| [Docker](./docker.md)         | the `docker` provider: its config, the volume and container model, the sign-in volume, its gaps             |

The contract ships first. Docker builds on it next, because it needs no account and runs in CI, and
Sprites builds on it last.

## Decisions

- **One relay, shared by every provider that has a byte stream to the host.** Framing, acks and
  de-duplication live once in `openStreamRelay`, and a provider supplies only a `RelayLink`. imp
  keeps its reverse forward, so its behaviour does not change.
- **How a host supplies credentials is one tagged union, `HostCredentials`.** The daemon decides a
  launch's credentials in one pure function, `decideHarnessAuth`, and never branches on the provider
  kind.
- **A Sprites session signs in through a connector, and no credential value enters the sprite.** The
  agent's base URL points at the connector's gateway URL, and its token is a placeholder.
  [0001](../../decisions/0001-sprites-credentials-through-connectors.md)
- **A Sprites target's sprite name prefix is its grant.** A connector's access policy admits sprites
  by name prefix, and Sprites has no API to label a sprite. So one target serves one set of
  connectors, and a second set of credentials needs a second target with its own prefix.
- **A Docker host is a volume, and each harness is the main process of its own container.**
  `docker exec` cannot reattach, and `POST /containers/{id}/attach` can. Without sub-sessions, one
  session is one volume and one container, as one session is one imp.
- **A kill sleeps the harness on every remote provider.** imp sleeps the imp, Sprites detaches every
  exec and lets the sprite sleep, and Docker pauses the session's containers.
- **A Docker session runs under one sign-in that the user stores once per target.** Docker has no
  broker, and the target runs on the user's own machine, so the sign-in moves no trust that a local
  session lacks.

## Out of scope

- A credential gateway that atc runs itself on the daemon's machine. Sprites has connectors, and a
  local Docker target holds the user's own sign-in.
- Codex on Sprites and Docker. Codex's subscription sign-in has no connector route, and the Docker
  sign-in volume holds Claude's sign-in only.
- Sprites checkpoints and egress policy. A sprite runs with the default network policy.
- A Docker Engine on another machine. The provider bind-mounts files from the daemon's machine.
- Moving imp onto `openStreamRelay`, which would close the window in which imp loses a hook while
  its forward reconnects.
